#!/usr/bin/env python3
"""Batch card embedder: (re-)embeds every live card whose embed_hash differs
from the stored one — a full run on a fresh database, a handful of errata'd
cards on a typical week.

  DATABASE_URL=... python scripts/embed.py            # Bedrock Titan V2
  DATABASE_URL=... python scripts/embed.py --fake     # deterministic fake, no AWS

Runs in the mtg-ingest workflow (GitHub Actions, OIDC role with
bedrock:InvokeModel), never in Lambda. Titan V2 at 512 dims costs ~$0.02/M
tokens: the full ~35k-card run is under $0.50, incremental runs are noise.
"""

import argparse
import hashlib
import json
import math
import random
import sys
import time
from collections.abc import Callable

import psycopg
from psycopg.rows import dict_row

from mtg_api.config import database_url
from mtg_api.similar.embed_text import DIMENSIONS, MODEL_ID, embed_hash, embed_text

BATCH = 100


def fake_embedder(text: str) -> list[float]:
    """Deterministic unit-norm vector seeded by the text hash — lets tests
    and local smoke runs exercise the full pipeline without AWS."""
    rng = random.Random(hashlib.sha256(text.encode()).digest())
    vec = [rng.gauss(0, 1) for _ in range(DIMENSIONS)]
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def titan_embedder() -> Callable[[str], list[float]]:
    import boto3

    client = boto3.client("bedrock-runtime", region_name="us-west-2")

    def embed(text: str) -> list[float]:
        resp = client.invoke_model(
            modelId=MODEL_ID,
            body=json.dumps({"inputText": text, "dimensions": DIMENSIONS, "normalize": True}),
        )
        return json.loads(resp["body"].read())["embedding"]

    return embed


def stale_cards(conn: psycopg.Connection) -> list[tuple[str, str, str]]:
    """(oracle_id, embed_text, embed_hash) for live cards needing work."""
    rows = conn.execute(
        "SELECT c.oracle_id, c.name, c.type_line, c.oracle_text, c.keywords, c.power, "
        "c.toughness, c.loyalty, c.defense, c.mana_value, c.color_identity, "
        "e.embed_hash AS stored_hash "
        "FROM cards c LEFT JOIN card_embeddings e ON e.oracle_id = c.oracle_id "
        "WHERE NOT c.is_removed"
    ).fetchall()
    stale = []
    for card in rows:
        text = embed_text(card)
        h = embed_hash(text)
        if h != card["stored_hash"]:
            stale.append((str(card["oracle_id"]), text, h))
    return stale


def main() -> int:
    parser = argparse.ArgumentParser(description="embed stale cards")
    parser.add_argument("--fake", action="store_true", help="deterministic embedder, no AWS")
    parser.add_argument("--limit", type=int, default=None, help="cap cards this run")
    args = parser.parse_args()

    embedder = fake_embedder if args.fake else titan_embedder()
    model = f"fake-{DIMENSIONS}" if args.fake else MODEL_ID

    started = time.monotonic()
    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        stale = stale_cards(conn)
        if args.limit:
            stale = stale[: args.limit]
        print(f"embed: {len(stale)} stale card(s) (model {model})")
        done = 0
        for i in range(0, len(stale), BATCH):
            chunk = stale[i : i + BATCH]
            params = [
                (oid, "[" + ",".join(f"{v:.6f}" for v in embedder(text)) + "]", model, h)
                for oid, text, h in chunk
            ]
            conn.cursor().executemany(
                "INSERT INTO card_embeddings (oracle_id, embedding, model, embed_hash, updated_at) "
                "VALUES (%s, %s::halfvec, %s, %s, now()) "
                "ON CONFLICT (oracle_id) DO UPDATE SET embedding = excluded.embedding, "
                "model = excluded.model, embed_hash = excluded.embed_hash, updated_at = now()",
                params,
            )
            conn.commit()
            done += len(chunk)
            if done % 2000 < BATCH:
                print(f"embed: {done}/{len(stale)}")
        elapsed = time.monotonic() - started
        print(f"embed: done — {done} embedded in {elapsed:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
