#!/usr/bin/env python3
"""Local dev server against the docker-compose Postgres, on :8001 so it can
run beside a local services/mtg-api on :8000 (the catalog it calls):

  DATABASE_URL=postgres://postgres:postgres@localhost:54330/postgres \
  MTG_API_BASE=http://localhost:8000 \
    python scripts/serve-local.py

PORT overrides the port. Auth defaults to the local dev issuer (ENV=local,
AUTH_ISSUER=urn:tcg-pos:dev-issuer; key pair created in .dev/auth/ on first
run): sign in with POST /v1/dev/login or scripts/dev_token.py. Set
AUTH_ISSUER / AUTH_CLIENT_IDS to try a real Cognito pool instead.
"""

import logging
import os

import uvicorn

from tcg_pos_api.auth.dev import DEV_ISSUER, ensure_keypair

if __name__ == "__main__":
    os.environ.setdefault("ENV", "local")
    os.environ.setdefault("AUTH_ISSUER", DEV_ISSUER)
    if os.environ["AUTH_ISSUER"] == DEV_ISSUER:
        ensure_keypair()

    from tcg_pos_api.app import create_app

    # uvicorn only configures its own loggers, so the app's INFO lines were
    # dropped — including the local-only invite accept link
    # (routes/staff.deliver_invite).
    logging.basicConfig(format="%(levelname)s:     %(name)s: %(message)s")
    logging.getLogger("tcg_pos_api").setLevel(logging.INFO)

    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "8001")))
