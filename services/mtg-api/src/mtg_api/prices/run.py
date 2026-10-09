"""Daily price snapshot.

  python -m mtg_api.prices.run [--feeds mtgjson,cardmarket_guide,scryfall] [--as-of YYYY-MM-DD]
                               [--changelog TEXT]

Fetches each feed, stages its rows, and freezes them into snapshot
YYYY-MM-DD.n (n = 1 for the first run of the day, then 2, 3, ... for
re-runs, which never alter an earlier revision). A feed that fails is
recorded in ingest_runs and the snapshot's sources_failed, the others still
publish, and the exit status is 1 so the workflow's failure email fires."""

import argparse
import csv
import io
import json
import sys
import traceback
from collections.abc import Callable, Iterable, Iterator
from datetime import UTC, date, datetime

import httpx
import psycopg

from mtg_api.config import SCRYFALL_USER_AGENT
from mtg_api.db import connect
from mtg_api.ingest import load
from mtg_api.ingest.bulk import _iter_lines
from mtg_api.ingest.run import summarize
from mtg_api.prices import fx, snapshot
from mtg_api.prices.sources import Obs, cardmarket_guide, mtgjson, scryfall

HEADERS = {"User-Agent": SCRYFALL_USER_AGENT}


def stream_text_lines(client: httpx.Client, url: str) -> Iterator[str]:
    """Lines of a (possibly gzipped) text file, streamed."""
    with client.stream("GET", url, headers=HEADERS, follow_redirects=True) as resp:
        resp.raise_for_status()
        for line in _iter_lines(resp):
            yield line.decode("utf-8")


def mtgjson_feed(conn: psycopg.Connection, client: httpx.Client) -> tuple[Iterable[Obs], datetime]:
    meta = next(csv.DictReader(io.StringIO(client.get(mtgjson.META_URL).text)))
    uuid_map = mtgjson.parse_identifiers(stream_text_lines(client, mtgjson.IDENTIFIERS_URL))
    published = datetime.fromisoformat(meta["date"]).replace(tzinfo=UTC)
    return mtgjson.observations(stream_text_lines(client, mtgjson.PRICES_URL), uuid_map), published


def cardmarket_feed(
    conn: psycopg.Connection, client: httpx.Client
) -> tuple[Iterable[Obs], datetime]:
    resp = client.get(cardmarket_guide.GUIDE_URL, headers=HEADERS)
    resp.raise_for_status()
    doc = json.loads(resp.content)
    product_map: dict[int, list[str]] = {}
    for cm_id, printing_id in conn.execute(
        "SELECT cardmarket_id, id FROM printings WHERE cardmarket_id IS NOT NULL"
    ):
        product_map.setdefault(cm_id, []).append(str(printing_id))
    return cardmarket_guide.observations(doc, product_map), cardmarket_guide.created_at(doc)


def scryfall_feed_for(as_of: date) -> Callable:
    def feed(conn: psycopg.Connection, client: httpx.Client) -> tuple[Iterable[Obs], datetime]:
        (latest,) = conn.execute("SELECT max(price_updated_at) FROM printings").fetchone()
        return scryfall.observations(conn, as_of), latest

    return feed


def fetch_fx(client: httpx.Client):
    try:
        resp = client.get(fx.ECB_DAILY_URL)
        resp.raise_for_status()
        return fx.parse_ecb_usd(resp.text)
    except Exception as err:  # FX is reported, not load-bearing; never fail the run on it.
        print(f"fx: ECB rate unavailable ({err}); snapshot records NULL", file=sys.stderr)
        return None


def run_snapshot(
    conn: psycopg.Connection,
    feeds: dict[str, Callable],
    as_of: date,
    client: httpx.Client | None,
    fx_rate=None,
    changelog: str | None = None,
) -> tuple[dict, list[str]]:
    """Stage every feed (each in its own savepoint), then take the snapshot
    in the same transaction. Returns (snapshot result, summary lines)."""
    lines = []
    ok, failed = [], []
    staged_by_run: dict[int, int] = {}
    failed_runs: list[int] = []
    snapshot.open_staging(conn)
    conn.commit()
    for name, feed in feeds.items():
        run_id = None
        try:
            observations, published = feed(conn, client)
            run_id = load.start_run(conn, f"prices:{name}", published)
            # Rows stream from the network inside this block; a failure
            # mid-file discards only this feed's staged rows.
            with conn.transaction():
                staged = snapshot.stage(conn, observations)
            staged_by_run[run_id] = staged
            ok.append(name)
            lines.append(f"- {name}: {staged} rows staged (published {published})")
        except Exception as err:
            conn.rollback()
            failed.append(name)
            traceback.print_exc()
            if run_id is None:
                run_id = load.start_run(conn, f"prices:{name}", None)
            load.finish_run(conn, run_id, "failed", error=f"{err}")
            failed_runs.append(run_id)
            lines.append(f"- {name}: **failed** — {err}")

    result = snapshot.take(
        conn,
        as_of=as_of,
        sources_ok=ok,
        sources_failed=failed,
        fx=fx_rate,
        changelog=changelog,
    )
    conn.commit()
    for run_id, staged in staged_by_run.items():
        load.finish_run(conn, run_id, "ok", {"inserted": staged})
    conn.execute(
        "UPDATE ingest_runs SET game = 'mtg', snapshot_id = %s WHERE id = ANY(%s)",
        (result["snapshot_id"], [*staged_by_run, *failed_runs]),
    )
    conn.commit()
    counts = result["row_counts"]
    lines.insert(0, f"### price snapshot {result['snapshot_id']}")
    lines.append(
        "- written: "
        + ", ".join(f"{k} {v}" for k, v in sorted(counts.items()) if not k.startswith("_"))
    )
    lines.append(
        f"- new SKUs {counts['_skus_created']}, unmatched staged rows "
        f"{counts['_unmatched_staged']}, movers {counts['_movers']}"
    )
    if fx_rate:
        lines.append(f"- ECB EUR/USD {fx_rate[0]} ({fx_rate[1]})")
    return result, lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Daily price snapshot")
    parser.add_argument("--feeds", default="mtgjson,cardmarket_guide,scryfall")
    parser.add_argument("--as-of", type=date.fromisoformat, default=None)
    parser.add_argument("--changelog", default=None, help="why this revision exists")
    args = parser.parse_args(argv)
    as_of = args.as_of or datetime.now(UTC).date()
    available = {
        "mtgjson": mtgjson_feed,
        "cardmarket_guide": cardmarket_feed,
        "scryfall": scryfall_feed_for(as_of),
    }
    names = [f.strip() for f in args.feeds.split(",") if f.strip()]
    unknown = [f for f in names if f not in available]
    if unknown:
        parser.error(f"unknown feeds: {', '.join(unknown)}")
    with connect() as conn, httpx.Client(timeout=300) as client:
        _, lines = run_snapshot(
            conn,
            {n: available[n] for n in names},
            as_of,
            client,
            fx_rate=fetch_fx(client),
            changelog=args.changelog,
        )
    summarize(lines)
    return 1 if any("**failed**" in line for line in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
