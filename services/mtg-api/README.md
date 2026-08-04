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

## Similarity

`GET /v1/cards/{oracle_id}/similar` — mechanically synergistic suggestions,
deliberately not decklist co-occurrence. Pipeline: Bedrock Titan V2
embeddings (`halfvec(512)` + HNSW, `migrations/0004`) over canonical card
text (`similar/embed_text.py`: self-references → CARDNAME, reminder text
stripped) → top-200 cosine candidates → hybrid rescore
(`similar/scoring.py`: 0.55 cosine + 0.25 mechanic jaccard + 0.10 type
overlap + 0.10 resource signals) → calibrated confidence with bands and
human-readable reasons.

- `scripts/embed.py` (re-)embeds only cards whose `embed_hash` changed; runs
  in the ingest workflow behind `MTG_EMBED_ENABLED` (needs Bedrock IAM).
  `--fake` uses a deterministic offline embedder for tests/local dev.
- `scripts/eval_similar.py` scores the engine against
  `eval/golden_synergies.yaml` (recall@10 gate: ≥ 0.5);
  `--fit-calibration` refreshes the confidence constants in `scoring.py`
  (shipped provisional until the first real embed run).

## API keys & rate limits

Every endpoint works anonymously; an API key (`mtg_live_...`, issued
manually — see `scripts/issue_key.py`) only buys a higher per-minute rate
limit, never access to card data itself. Full consumer-facing reference —
how to send a key, tier limits, the 429/`Retry-After`/`X-RateLimit-*`
contract, licensing/attribution — in
[`docs/third-party-api.md`](docs/third-party-api.md).

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

One-time bootstrap (admin credentials) — the consolidated, ordered checklist
across all phases lives in [`OPS.md`](OPS.md); summary:

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
6. For similarity: the role policy includes `bedrock:InvokeModel` on Titan
   Text Embeddings V2; set `MTG_EMBED_ENABLED=true` to add the embed step to
   the ingest cron (first run embeds all ~35k cards, ≈$0.50 one-time), then
   run `scripts/eval_similar.py --fit-calibration` and commit the refreshed
   constants in `src/mtg_api/similar/scoring.py`.

## Attribution

Card data © Wizards of the Coast, provided by [Scryfall](https://scryfall.com).
This project is unofficial Fan Content permitted under the
[Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
and is not endorsed by Scryfall or Wizards of the Coast. Per
[Scryfall's terms](https://scryfall.com/docs/terms), card data served by this
project is never paywalled.
