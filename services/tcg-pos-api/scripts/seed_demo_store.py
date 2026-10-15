#!/usr/bin/env python3
"""Seed a demo storefront for local development (never a real database):

  DATABASE_URL=postgres://postgres:postgres@localhost:54329/tcg_pos_dev \
    python scripts/seed_demo_store.py --slug demo [--cards 250] [--seed 7]

Creates a tenant with one location, a published storefront at --slug, and a
few hundred inventory items, then lets the listings indexer pick them up
through the search_outbox like any other write.

  * Cards are REAL: popular paper cards (EDHREC rank) read from the live
    `catalog` OpenSearch alias, plus a few staples by name, with real
    printing ids. Nothing reads mtg_dev.
  * Stock goes through the API's own write path (POST /v1/inventory/adjust
    with price_cents, in-process), so every item has its ledger, audit and
    outbox rows. The storefront is created with PUT /v1/storefront-settings.
    Only the tenant + location rows are inserted directly, which needs
    DATABASE_URL to be a role that may insert tenants (the local postgres
    superuser). The API calls are made as a dev-issuer user (SEED_EMAIL)
    made the store's owner by backfill_owner.py, so the ledger and audit
    rows carry that user as their actor.
  * Prices: the printing's catalog NM reference (TCGplayer market, else
    Scryfall) through the POS default price rule for the condition
    (pricing.apply_rule) — the same math as /pricing/suggest. A few items are
    left unpriced on purpose (they must never list online).
  * Deterministic for a given --seed. Refuses to run if the slug exists.
"""

import argparse
import os
import random
import sys
from pathlib import Path

import psycopg
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from tcg_search.client import OpenSearch

from tcg_pos_api.auth.dev import DEV_ISSUER, dev_sub, mint_dev_token
from tcg_pos_api.pricing import DEFAULT_RULE, apply_rule
from tcg_pos_api.search import catalog_alias

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backfill_owner  # noqa: E402

STAPLES = ["Lightning Bolt", "Counterspell", "Sol Ring", "Tarmogoyf", "Thoughtseize",
           "Llanowar Elves", "Swords to Plowshares", "Dark Ritual", "Brainstorm",
           "Birds of Paradise", "Path to Exile", "Ponder", "Fatal Push", "Opt",
           "Shivan Dragon", "Serra Angel", "Rhystic Study", "Cyclonic Rift"]
CONDITIONS = ["NM"] * 6 + ["LP"] * 3 + ["MP", "HP"]
SEED_EMAIL = "owner@demo.test"


def popular_cards(os_: OpenSearch, n: int) -> list[dict]:
    body = {
        "size": n,
        "query": {"bool": {"must_not": [{"term": {"digital_only": True}}],
                           "filter": [{"exists": {"field": "price_cents"}}]}},
        "sort": [{"edhrec_rank": {"order": "asc", "missing": "_last"}}],
        "_source": ["oracle_id", "name", "printings"],
    }
    hits = os_.search(catalog_alias(), body)["hits"]["hits"]
    named = os_.search(catalog_alias(), {
        "size": len(STAPLES),
        "query": {"terms": {"name.sort": [s.lower() for s in STAPLES]}},
        "_source": ["oracle_id", "name", "printings"],
    })["hits"]["hits"]
    seen, out = set(), []
    for h in named + hits:
        if h["_id"] not in seen:
            seen.add(h["_id"])
            out.append(h["_source"])
    return out


def stock_lines(cards: list[dict], rng: random.Random) -> list[dict]:
    lines = []
    for card in cards:
        priced = [p for p in card.get("printings") or []
                  if p.get("price_cents") or p.get("price_foil_cents")]
        if not priced:
            continue
        picks = rng.sample(priced, k=min(len(priced), rng.choice([1, 1, 1, 2, 3])))
        for p in picks:
            finishes = [f for f, key in (("nonfoil", "price_cents"), ("foil", "price_foil_cents"))
                        if p.get(key)]
            finish = rng.choice(finishes)
            ref = p["price_cents"] if finish == "nonfoil" else p["price_foil_cents"]
            for condition in sorted(set(rng.sample(CONDITIONS, k=rng.choice([1, 1, 2])))):
                price = apply_rule(ref, condition, DEFAULT_RULE)
                if rng.random() < 0.02:
                    price = None  # unpriced: on the shelf, never online
                lines.append({"printing_id": p["printing_id"], "finish": finish,
                              "condition": condition, "qty": rng.choice([1, 1, 2, 3, 4, 6, 8]),
                              "price_cents": price, "name": card["name"],
                              "set": p.get("set")})
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--slug", default="demo")
    parser.add_argument("--name", default="Demo Games & Cards")
    parser.add_argument("--cards", type=int, default=250)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    url = os.environ.get("DATABASE_URL", "")
    if "tcg_pos_dev" not in url and "--i-know" not in sys.argv:
        print("refusing: DATABASE_URL should be the local tcg_pos_dev database", file=sys.stderr)
        return 2

    with psycopg.connect(url, autocommit=True) as admin:
        if admin.execute("SELECT 1 FROM storefront WHERE slug = %s", (args.slug,)).fetchone():
            print(f"storefront {args.slug!r} already exists; nothing to do", file=sys.stderr)
            return 1
        tenant = admin.execute("INSERT INTO tenant (name) VALUES (%s) RETURNING id",
                               (args.name,)).fetchone()[0]
        location = admin.execute(
            "INSERT INTO location (tenant_id, name) VALUES (%s, 'Main Street') RETURNING id",
            (tenant,)).fetchone()[0]

    rng = random.Random(args.seed)
    with OpenSearch() as os_:
        cards = popular_cards(os_, args.cards)
    lines = stock_lines(cards, rng)
    with psycopg.connect(url, row_factory=dict_row) as admin, admin.transaction():
        backfill_owner.backfill(admin, tenant, dev_sub(SEED_EMAIL), SEED_EMAIL)
    os.environ.setdefault("ENV", "local")
    os.environ["AUTH_ISSUER"] = DEV_ISSUER
    from tcg_pos_api.app import create_app

    hdr = {"X-Tenant-Id": str(tenant),
           "Authorization": f"Bearer {mint_dev_token(SEED_EMAIL)}"}
    with TestClient(create_app()) as api:
        resp = api.put("/v1/storefront-settings", headers=hdr, json={
            "slug": args.slug, "display_name": args.name, "published": True,
            "location_id": str(location), "holdback_copies": 0, "holdback_pct": 0,
            "reservation_hours": 48, "pickup_text": "Pick up at the front counter.",
            "policy_text": "Reservations are held for 48 hours. Pay in store.",
        })
        resp.raise_for_status()
        for line in lines:
            resp = api.post("/v1/inventory/adjust", headers=hdr, json={
                "location_id": str(location), "printing_id": line["printing_id"],
                "condition": line["condition"], "finish": line["finish"],
                "delta": line["qty"], "reason": "demo seed", "price_cents": line["price_cents"],
            })
            resp.raise_for_status()
    priced = sum(1 for x in lines if x["price_cents"] is not None)
    print(f"tenant {tenant}, location {location}, storefront /{args.slug}: "
          f"{len(lines)} items ({priced} priced) across {len({x['name'] for x in lines})} "
          f"cards, {sum(x['qty'] for x in lines)} copies")
    return 0


if __name__ == "__main__":
    sys.exit(main())
