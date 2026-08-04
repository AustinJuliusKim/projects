# mtg-api

MTG card database: Scryfall bulk ingest into Postgres (this phase), a FastAPI
service on Lambda (phase 2), and mechanics/text-based card similarity
(phase 3). The full roadmap, cost analysis, and locked decisions live in
[`docs/PLAN.md`](docs/PLAN.md).

The repo's first Python project: `pytest` + `ruff`, per-project `.venv`,
pinned deps in `requirements-dev.txt` (the lockfile). Migrations follow the
`services/guided-repl-api` pattern — plain numbered SQL applied by
`scripts/migrate.py`, recorded in `schema_migrations`, one transaction per
file.

## Data

- **`cards`** — one row per unique oracle card (~35k) from Scryfall's
  `oracle-cards` bulk file. Content-hashed: unchanged cards cost nothing to
  re-ingest, and hash changes drive phase-3 re-embedding. Soft-deleted, never
  dropped.
- **`printings`** — slim per-set printing rows (~110k) from `default-cards`:
  set, collector number, rarity, image URIs, prices. Prices sit outside the
  content hash and update independently.
- **`rulings`**, **`sets`**, **`ingest_runs`** (per-run observability).

Ingest runs on a GitHub Actions cron (`.github/workflows/mtg-ingest.yml`,
Mon+Thu) streaming the JSONL bulk files straight into Postgres — no Lambda,
no disk. It no-ops until the `MTG_DATABASE_URL` repo secret exists.

## Develop

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

docker compose up -d      # local pgvector Postgres on :54329
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres python scripts/migrate.py

ruff check .
pytest                    # integration tests skip without TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pytest

# Full local ingest of real Scryfall data (~35k cards + ~110k printings)
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres \
  python -m mtg_api.ingest.run --sources oracle,default,rulings
```

Against Supabase, ingest uses the **session pooler** URI (port 5432); the
phase-2 Lambda will use the transaction pooler (6543).

## Deploy

Nothing deploys to AWS yet. Phase 2 adds the SAM template, the deploy
workflow job, and `docs/iam-policy.json`.

## Attribution

Card data © Wizards of the Coast, provided by [Scryfall](https://scryfall.com).
This project is unofficial Fan Content permitted under the
[Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
and is not endorsed by Scryfall or Wizards of the Coast. Per
[Scryfall's terms](https://scryfall.com/docs/terms), card data served by this
project is never paywalled.
