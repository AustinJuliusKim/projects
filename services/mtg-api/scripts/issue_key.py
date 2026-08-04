#!/usr/bin/env python3
"""Issue or revoke mtg-api keys. The plaintext key is printed exactly once —
only its sha256 hash is ever written to the database, so if you lose it the
only fix is issuing a new one.

  DATABASE_URL=... python scripts/issue_key.py --tier free --label "acme app"
  DATABASE_URL=... python scripts/issue_key.py --revoke mtg_live_...
  DATABASE_URL=... python scripts/issue_key.py --revoke <sha256 hex>
"""

import argparse
import sys

import psycopg

from mtg_api.apikeys import TIERS, generate_key, hash_key, resolve_key_sha256
from mtg_api.config import database_url


def issue(conn: psycopg.Connection, tier: str, label: str | None) -> None:
    key = generate_key()
    conn.execute(
        "INSERT INTO api_keys (key_sha256, tier, label) VALUES (%s, %s, %s)",
        (hash_key(key), tier, label),
    )
    conn.commit()
    print(f"issued a {tier!r} key — store this now, it will not be shown again:")
    print(key)


def revoke(conn: psycopg.Connection, key_or_sha256: str) -> None:
    key_sha256 = resolve_key_sha256(key_or_sha256)
    row = conn.execute(
        "UPDATE api_keys SET revoked_at = now() "
        "WHERE key_sha256 = %s AND revoked_at IS NULL "
        "RETURNING id, tier, label",
        (key_sha256,),
    ).fetchone()
    if row is None:
        print(f"issue_key: no active key matches {key_sha256[:12]}...", file=sys.stderr)
        sys.exit(1)
    conn.commit()
    print(f"revoked key id={row[0]} tier={row[1]} label={row[2]!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description="issue or revoke mtg-api keys")
    parser.add_argument("--tier", choices=TIERS, help="tier for a new key")
    parser.add_argument("--label", default=None, help="free-text note on who/what the key is for")
    parser.add_argument("--revoke", metavar="KEY_OR_SHA256", help="revoke an existing key")
    args = parser.parse_args()

    if args.revoke and args.tier:
        parser.error("--revoke and --tier are mutually exclusive")
    if not args.revoke and not args.tier:
        parser.error("either --tier (to issue) or --revoke is required")

    with psycopg.connect(database_url()) as conn:
        if args.revoke:
            revoke(conn, args.revoke)
        else:
            issue(conn, args.tier, args.label)
    return 0


if __name__ == "__main__":
    sys.exit(main())
