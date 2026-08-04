# mtg-api

MTG card database: Scryfall bulk ingest into Postgres, and a read-only
FastAPI service on Lambda (SAM + HttpApi) with public OpenAPI docs at `/docs`.
Mechanics/text-based card similarity lands in phase 3. The full roadmap, cost
analysis, and locked decisions live in [`docs/PLAN.md`](docs/PLAN.md).

The repo's first Python project: `pytest` + `ruff`, per-project `.venv`,
pinned deps in `requirements-dev.txt` (the lockfile; Lambda runtime pins in
`src/requirements.txt`). Migrations follow the `services/guided-repl-api`
pattern — plain numbered SQL applied by `scripts/migrate.py`, recorded in
`schema_migrations`, one transaction per file.

## Data

- **`cards`** — one row per unique oracle card (~35k) from Scryfall's
  `oracle-cards` bulk file. Content-hashed: unchanged cards cost nothing to
  re-ingest, and hash changes drive phase-3 re-embedding. Soft-deleted, never
  dropped. Names are not unique (Unfinity variants).
- **`printings`** — slim per-set printing rows (~110k) from `default-cards`:
  set, collector number, rarity, image URIs, prices. Prices sit outside the
  content hash and update independently.
- **`rulings`**, **`sets`**, **`ingest_runs`** (per-run observability).

Ingest runs on a GitHub Actions cron (`.github/workflows/mtg-ingest.yml`,
Mon+Thu) streaming the JSONL bulk files straight into Postgres — no Lambda,
no disk. It no-ops until the `MTG_DATABASE_URL` repo secret exists.

## API

FastAPI app factory in `src/mtg_api/app.py`, wrapped for Lambda by Mangum in
`src/mtg_api/lambda_handler.py`. Read-only surface under `/v1`: card search
(FTS + color/identity/type/keyword/mana-value/format filters), exact/fuzzy
named lookup, autocomplete, random, card detail with representative printing
images, rulings, printings with prices, sets, healthz. Interactive docs at
`/docs`, spec at `/openapi.json`, both public.

## Environment

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Lambda: Supabase **transaction pooler** (`:6543`). Ingest/migrations: **session pooler** (`:5432`). |
| `SCRYFALL_USER_AGENT` | Optional override for the ingest's User-Agent header |

## Develop

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

docker compose up -d      # local pgvector Postgres on :54329
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres
python scripts/migrate.py

ruff check .
pytest                    # DB-backed suites skip without TEST_DATABASE_URL
TEST_DATABASE_URL=$DATABASE_URL pytest

# Full local ingest of real Scryfall data, then browse the API
python -m mtg_api.ingest.run
python scripts/serve-local.py   # http://127.0.0.1:8000/docs
```

## Deploy

CI deploys on push to `main` (`.github/workflows/mtg.yml` `deploy` job), but
only once the one-time bootstrap below is done and the repo variable
`MTG_DEPLOY_ENABLED` is `true`. CI passes no `--parameter-overrides`; the
stack's existing `DatabaseUrl` is reused via `UsePreviousValue`.

One-time bootstrap (admin credentials):

1. Create the Supabase project (Free tier). In SQL editor create the
   `mtg_ingest` role; run the first `scripts/migrate.py` **as that role** so
   it owns the mtg tables — the deploy job's migration step and the ingest
   cron both run as `mtg_ingest`, and owning the tables is what lets later
   migrations `ALTER` them without a superuser.
2. Set the `MTG_DATABASE_URL` repo secret (session pooler URI, `:5432`).
3. Create the IAM role `mtg-api-github-deploy` from
   [`docs/iam-policy.json`](docs/iam-policy.json) with the repo's GitHub OIDC
   trust policy (same shape as the other `*-github-deploy` roles).
4. First stack creation is manual with full overrides:

   ```bash
   sam build && sam deploy \
     --stack-name MtgApi --region us-west-2 --resolve-s3 \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides "DatabaseUrl=<transaction pooler URI, :6543>"
   ```

5. Set the repo variable `MTG_DEPLOY_ENABLED=true` to arm the CI deploy job.

## Attribution

Card data © Wizards of the Coast, provided by [Scryfall](https://scryfall.com).
This project is unofficial Fan Content permitted under the
[Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
and is not endorsed by Scryfall or Wizards of the Coast. Per
[Scryfall's terms](https://scryfall.com/docs/terms), card data served by this
project is never paywalled.
