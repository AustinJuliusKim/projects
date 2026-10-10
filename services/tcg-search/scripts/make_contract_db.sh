#!/usr/bin/env bash
# (Re)create the scratch database for tests/test_extract_contract.py: the
# mtg catalog schema from mtg-api's own migrations + its test fixtures.
# Never points at mtg_dev.
#
#   MTG_API_DIR=/path/to/services/mtg-api scripts/make_contract_db.sh
#
# MTG_API_DIR must be an mtg-api checkout that has the price migrations
# (0010-0013, branch prices-c-api or later) and its own .venv (make install).
# Default: the projects-prices worktree, read-only use.
set -euo pipefail
MTG_API_DIR=${MTG_API_DIR:-/mnt/c/Users/austi/personal/projects-prices/services/mtg-api}
ADMIN_URL=${ADMIN_URL:-postgres://postgres:postgres@localhost:54329/postgres}
DB=${CONTRACT_DB:-search_contract_test}
case "$DB" in mtg_dev|postgres|tcg_pos_test) echo "refusing to recreate $DB" >&2; exit 1;; esac
URL="${ADMIN_URL%/*}/$DB"

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
cd "$MTG_API_DIR"
DATABASE_URL="$URL" .venv/bin/python scripts/migrate.py
DATABASE_URL="$URL" .venv/bin/python - <<'PY'
import json, os
import psycopg
from mtg_api.ingest.run import ingest_default, ingest_oracle

def load(name):
    with open(f"tests/fixtures/{name}", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]

with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    print("oracle", ingest_oracle(conn, load("oracle_sample.jsonl")))
    print("default", ingest_default(conn, load("default_sample.jsonl")))
PY
echo "TEST_CATALOG_DATABASE_URL=$URL"
