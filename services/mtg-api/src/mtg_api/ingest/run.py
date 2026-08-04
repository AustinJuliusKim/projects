"""Ingest orchestrator.

  python -m mtg_api.ingest.run --sources oracle,default,rulings [--force]

Streams Scryfall bulk JSONL straight into Postgres. Each source is gated on
the bulk file's updated_at (skip if unchanged since the last successful run,
unless --force) and recorded in ingest_runs. Sources run in the given order;
`oracle` should precede `default` so printings can resolve their card FK."""

import argparse
import os
import sys
import traceback
from collections.abc import Iterable
from typing import Any

import httpx
import psycopg

from mtg_api.db import connect
from mtg_api.ingest import bulk, load, transform


def ingest_oracle(conn: psycopg.Connection, objects: Iterable[dict[str, Any]]) -> dict[str, int]:
    inserted = updated = 0
    seen: set[str] = set()

    def rows() -> Iterable[dict[str, Any]]:
        for card in objects:
            row = transform.card_row(card)
            # Dedupe within the run: a repeated oracle_id in one multi-row
            # upsert would error ("cannot affect row a second time").
            if row is None or row["oracle_id"] in seen:
                continue
            seen.add(row["oracle_id"])
            yield row

    for batch in load.chunked(rows()):
        i, u = load.upsert_cards(conn, batch)
        conn.commit()
        inserted += i
        updated += u
    removed = load.apply_card_removals(conn, seen)
    conn.commit()
    return {"inserted": inserted, "updated": updated, "removed": removed}


def ingest_default(conn: psycopg.Connection, objects: Iterable[dict[str, Any]]) -> dict[str, int]:
    inserted = updated = prices_changed = skipped_fk = 0
    seen: set[str] = set()
    seen_sets: set[str] = set()
    known_oracle_ids = load.existing_oracle_ids(conn)
    for raw_batch in load.chunked(objects):
        printing_rows = []
        price_rows = []
        set_rows = []
        for card in raw_batch:
            row = transform.printing_row(card)
            if row is None or row["id"] in seen:
                continue
            # A printing whose card isn't in `cards` (filtered layout, or the
            # oracle pass never ran) can't satisfy the FK — skip, don't fail.
            if row["oracle_id"] not in known_oracle_ids:
                skipped_fk += 1
                continue
            if row["set_code"] not in seen_sets:
                seen_sets.add(row["set_code"])
                set_rows.append(transform.set_row(card))
            printing_rows.append(row)
            price_rows.append(transform.prices_row(card))
            seen.add(row["id"])
        load.upsert_sets(conn, set_rows)
        if printing_rows:
            i, u = load.upsert_printings(conn, printing_rows)
            inserted += i
            updated += u
            prices_changed += load.update_prices(conn, price_rows)
        conn.commit()
    removed = load.apply_printing_removals(conn, seen)
    conn.commit()
    if skipped_fk:
        print(f"default: skipped {skipped_fk} printings with unknown oracle_id")
    return {
        "inserted": inserted,
        "updated": updated + prices_changed,
        "removed": removed,
    }


def ingest_rulings(conn: psycopg.Connection, objects: Iterable[dict[str, Any]]) -> dict[str, int]:
    loaded = load.reload_rulings(conn, (transform.ruling_row(r) for r in objects))
    conn.commit()
    return {"inserted": loaded, "updated": 0, "removed": 0}


INGESTERS = {
    "oracle": ingest_oracle,
    "default": ingest_default,
    "rulings": ingest_rulings,
}


def summarize(lines: list[str]) -> None:
    text = "\n".join(lines) + "\n"
    print(text, end="")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scryfall bulk ingest")
    parser.add_argument(
        "--sources",
        default="oracle,default,rulings",
        help="comma-separated subset of: oracle, default, rulings (order matters)",
    )
    parser.add_argument(
        "--force", action="store_true", help="ingest even if the bulk file is unchanged"
    )
    args = parser.parse_args(argv)
    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    unknown = [s for s in sources if s not in INGESTERS]
    if unknown:
        parser.error(f"unknown sources: {', '.join(unknown)}")

    summary = ["### mtg ingest"]
    failed = False
    with connect() as conn, httpx.Client(timeout=120) as client:
        files = bulk.fetch_bulk_index(client)
        for source in sources:
            info = files[source]
            last = load.last_success_bulk_updated_at(conn, source)
            if not args.force and last is not None and last == info.updated_at:
                summary.append(
                    f"- {source}: unchanged since {info.updated_at:%Y-%m-%d %H:%M} — skipped"
                )
                continue
            run_id = load.start_run(conn, source, info.updated_at)
            try:
                counts = INGESTERS[source](conn, bulk.stream_objects(client, info.download_uri))
                load.finish_run(conn, run_id, "ok", counts)
                summary.append(
                    f"- {source}: {counts['inserted']} inserted, "
                    f"{counts['updated']} updated, {counts['removed']} removed"
                )
            except Exception as err:
                conn.rollback()
                load.finish_run(conn, run_id, "failed", error=f"{err}")
                summary.append(f"- {source}: **failed** — {err}")
                traceback.print_exc()
                failed = True
    summarize(summary)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
