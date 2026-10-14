#!/usr/bin/env python3
"""Local dev server against the docker-compose Postgres, on :8001 so it can
run beside a local services/mtg-api on :8000 (the catalog it calls):

  DATABASE_URL=postgres://postgres:postgres@localhost:54330/postgres \
  MTG_API_BASE=http://localhost:8000 \
    python scripts/serve-local.py

PORT overrides the port.
"""

import os

import uvicorn

from tcg_pos_api.app import create_app

if __name__ == "__main__":
    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "8001")))
