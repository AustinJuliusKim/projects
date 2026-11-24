#!/usr/bin/env python3
"""Mint a dev-issuer access token (local dev only — see auth/dev.py):

  python scripts/dev_token.py owner@demo.test            # prints the token
  python scripts/dev_token.py owner@demo.test --sub      # prints the sub only
  python scripts/dev_token.py owner@demo.test --id       # a matching ID token
  python scripts/dev_token.py --init                      # just create the key pair

The key pair lives in .dev/auth/ (gitignored; DEV_AUTH_DIR overrides) and is
created on first use. The API accepts these tokens only when it runs with
AUTH_ISSUER=urn:tcg-pos:dev-issuer and ENV=local/test (make serve / serve-dev
set both). What the token can do is decided by its user's store memberships:
scripts/backfill_owner.py makes a dev user an owner.

  curl -H "Authorization: Bearer $(python scripts/dev_token.py owner@demo.test)" \
       -H "X-Tenant-Id: <tenant uuid>" http://127.0.0.1:8001/v1/inventory
"""

import argparse
import sys

from tcg_pos_api.auth.dev import (
    DEFAULT_TTL_SECONDS,
    dev_auth_dir,
    dev_sub,
    ensure_keypair,
    mint_dev_id_token,
    mint_dev_token,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("email", nargs="?")
    parser.add_argument("--sub", action="store_true", help="print the dev sub for the email")
    parser.add_argument(
        "--id", action="store_true", help="print an ID token (for POST /v1/me/identity)"
    )
    parser.add_argument("--ttl", type=int, default=DEFAULT_TTL_SECONDS, help="seconds")
    parser.add_argument("--init", action="store_true", help="create the key pair and exit")
    args = parser.parse_args(argv)
    if args.init:
        print(ensure_keypair(), file=sys.stderr)
        return 0
    if not args.email:
        parser.error("email is required")
    if args.sub:
        print(dev_sub(args.email))
        return 0
    ensure_keypair()
    mint = mint_dev_id_token if args.id else mint_dev_token
    print(mint(args.email, ttl=args.ttl))
    print(f"(dev issuer keys: {dev_auth_dir()})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
