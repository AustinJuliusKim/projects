#!/usr/bin/env python3
"""Populates card_combo_pairs from Commander Spellbook's bulk combo export —
a rules-based known-combo catalog (not decklist co-occurrence), used to fix
the similarity engine's recall@10 gate: text-embedding cosine similarity
structurally can't find combo pairs whose oracle text shares no vocabulary
(see docs/PLAN.md and OPS.md phase 3 for the diagnosis).

  DATABASE_URL=... python scripts/sync_combos.py

Source: https://json.commanderspellbook.com/variants.json.gz — the same
bulk file Commander Spellbook's own frontend uses (their sitemap
generator), refreshed continuously on their end. No auth, no rate limit.
~27k combos / ~104k concrete card-combinations ("variants") at last check;
~26MB gzipped, ~600MB decompressed — too large for comfortable one-shot
`json.load` scrutiny, but well within a batch script's memory budget (this
is a periodic manual/ops job, never runs in Lambda). One HTTP GET, no
pagination, no scraping — idempotent to rerun as their data updates.

Attribution: combo data is unofficial Fan Content from Commander Spellbook
(commanderspellbook.com), not affiliated with Wizards of the Coast — see
docs/third-party-api.md.
"""

import json
import sys
import time

import httpx
import psycopg
from psycopg.rows import dict_row

from mtg_api.config import database_url

VARIANTS_URL = "https://json.commanderspellbook.com/variants.json.gz"
BATCH = 500


def fetch_variants() -> list[dict]:
    print("sync-combos: downloading variants.json.gz")
    resp = httpx.get(VARIANTS_URL, timeout=120, follow_redirects=True)
    resp.raise_for_status()
    # httpx transparently decodes the gzip Content-Encoding, so resp.content
    # is already the decompressed JSON text (~600MB) — no manual gzip step.
    print(f"sync-combos: downloaded {len(resp.content) / 1e6:.1f}MB, parsing")
    data = json.loads(resp.content)
    variants = data["variants"]
    print(f"sync-combos: {len(variants)} variant(s) in export (version {data.get('version')})")
    return variants


def accumulate_pairs(variants: list[dict], known_oracle_ids: set[str]) -> dict:
    """(oracle_id_a, oracle_id_b) -> {combo_count, strength, sample_produces,
    sample_popularity} for every pair of known cards that co-appear in at
    least one variant. `strength` sums 1/n_cards per co-membership, so a
    pair found together in a tight 2-card combo counts for more than one
    only incidentally sharing a sprawling 5-card combo; pairs recurring
    across multiple distinct combos accumulate."""
    pairs: dict[tuple[str, str], dict] = {}
    skipped_unknown = 0

    for variant in variants:
        oracle_ids = []
        for use in variant.get("uses", []):
            oid = use.get("card", {}).get("oracleId")
            if not oid:
                continue
            if oid not in known_oracle_ids:
                skipped_unknown += 1
                continue
            oracle_ids.append(oid)
        oracle_ids = sorted(set(oracle_ids))
        n = len(oracle_ids)
        if n < 2:
            continue

        produces = ", ".join(
            p["feature"]["name"] for p in variant.get("produces", []) if p.get("feature")
        )
        popularity = variant.get("popularity") or 0

        for i in range(n):
            for j in range(i + 1, n):
                key = (oracle_ids[i], oracle_ids[j])
                entry = pairs.setdefault(
                    key, {"combo_count": 0, "strength": 0.0, "sample_produces": None, "pop": -1}
                )
                entry["combo_count"] += 1
                entry["strength"] += 1.0 / n
                if popularity > entry["pop"]:
                    entry["pop"] = popularity
                    entry["sample_produces"] = produces or None

    if skipped_unknown:
        print(f"sync-combos: {skipped_unknown} card reference(s) not in our cards table (skipped)")
    return pairs


def upsert_pairs(conn: psycopg.Connection, pairs: dict) -> int:
    rows = [
        (a, b, v["combo_count"], v["strength"], v["sample_produces"], max(v["pop"], 0))
        for (a, b), v in pairs.items()
    ]
    done = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        conn.cursor().executemany(
            "INSERT INTO card_combo_pairs "
            "  (oracle_id_a, oracle_id_b, combo_count, strength, sample_produces, "
            "   popularity, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, now()) "
            "ON CONFLICT (oracle_id_a, oracle_id_b) DO UPDATE SET "
            "  combo_count = excluded.combo_count, strength = excluded.strength, "
            "  sample_produces = excluded.sample_produces, popularity = excluded.popularity, "
            "  updated_at = now()",
            chunk,
        )
        conn.commit()
        done += len(chunk)
        if done % 5000 < BATCH:
            print(f"sync-combos: {done}/{len(rows)} pair(s) upserted")
    return done


def main() -> int:
    started = time.monotonic()
    variants = fetch_variants()

    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        known = {
            str(row["oracle_id"])
            for row in conn.execute("SELECT oracle_id FROM cards WHERE NOT is_removed").fetchall()
        }
        print(f"sync-combos: {len(known)} known card(s) to match against")

        pairs = accumulate_pairs(variants, known)
        print(f"sync-combos: {len(pairs)} distinct combo pair(s) found")

        done = upsert_pairs(conn, pairs)
        elapsed = time.monotonic() - started
        print(f"sync-combos: done — {done} pair(s) upserted in {elapsed:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
