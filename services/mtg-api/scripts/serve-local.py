#!/usr/bin/env python3
"""Local dev server against the docker-compose Postgres:

  DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres \
    python scripts/serve-local.py
"""

import uvicorn

from mtg_api.app import create_app

if __name__ == "__main__":
    uvicorn.run(create_app(), host="127.0.0.1", port=8000)
