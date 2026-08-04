# MTG Card Database + API + Recommendations — Plan

## Context

Build and maintain an MTG card database (à la Scryfall/Gatherer) with a differentiator neither offers: **card similarity/recommendations driven by mechanics and card text**, not crowd-sourced decklists (EDHREC skews toward precons/staples and misses mechanically-synergistic or obscure cards). Roadmap: card DB + ingest → FastAPI API layer → search/deck-building webapp (Moxfield-like) → third-party API access (keys, rate limits, tiers) → possible recommendation model / RAG rank-rerank pipeline. The user asked for a written plan with costs scrutinized up front.

**Decisions locked with the user:** FastAPI (Python, repo's first Python service — anticipated by `docs/monorepo-conventions.md`); Supabase Free → Pro Postgres with pgvector (matches `services/guided-repl-api` precedent); data scope = full oracle cards (~35k) + slim printings table (~110k); budget **~$0–5/mo until it has users** (account-wide billing alarm is $35/mo in `ops/billing-alarms.yaml`).

**External facts verified (2026-08):**
- Scryfall bulk data is free, refreshed every 12–24h, and **JSONL-only since 2026-07-20** (`jsonl_download_uri`). Requires descriptive User-Agent + Accept headers. ([bulk data docs](https://scryfall.com/docs/api/bulk-data), [blog notice](https://scryfall.com/blog/updates-to-bulk-data-and-cards-deprecation-notice-217))
- **Licensing (WotC Fan Content Policy via [Scryfall terms](https://scryfall.com/docs/terms)): card data may never be paywalled** — anonymous free access must always exist. Paid tiers can only sell rate limits and own value-add (recommendations). No implied Scryfall/WotC endorsement.

**Vault caveat:** `ObsidianVault/` submodule is uninitialized here (private repo). No MTG notes could be checked; the vault's `30-projects/` should get a note for this project when the user next syncs (listed in Ops tasks).

## Status

Plan approved 2026-08-03. Phases 1–3 implemented (data layer + ingest merged in PR #74; FastAPI service merged in PR #75; similarity engine in this branch — confidence calibration provisional until the first real Bedrock embed run). Phase 4 (webapp) is next.

## Layout decision

One area: **`services/mtg-api/`** (API + ingest + migrations together — they share schema and row-shaping code, and cross-project imports are forbidden). Webapp later as `apps/mtg-webapp/`. **Ingest runs on GitHub Actions runners, not Lambda**: default-cards is 500MB+ JSONL and a full run can exceed Lambda's 15-min cap; the runner streams the HTTP body line-by-line (never hits disk), has free minutes (~150–200 min/mo used, under the 2,000 free-tier), and costs $0. Trade-off: `MTG_DATABASE_URL` becomes a GH Actions secret (new precedent) — mitigated with a dedicated `mtg_ingest` Postgres role with DML only on mtg tables.

**New-ecosystem decisions (explicit):** pytest (the `node --test` mandate is JS-scoped), ruff, `actions/setup-python@v5`, migration runner ported to Python preserving `services/guided-repl-api/scripts/migrate.js` semantics exactly (NNNN ordering, `schema_migrations`, one txn per file, `--dry-run` CI lint).

---

## Phase 1 — Data layer + ingest (PR 1, no AWS)

Files: `services/mtg-api/{README.md, pyproject.toml, requirements-dev.txt, docker-compose.yml (pgvector/pgvector:pg16), migrations/0001_extensions.sql (pgcrypto, pg_trgm, vector), migrations/0002_core.sql, migrations/0003_search.sql, scripts/migrate.py, src/mtg_api/{config.py, db.py, ingest/{bulk.py, transform.py, load.py, run.py}}, tests/{test_migrations.py, test_transform.py, test_ingest_integration.py, fixtures/*.jsonl}}` plus `.github/workflows/mtg-ingest.yml` (cron — schedule events ignore path filters, so separate file) and `.github/workflows/mtg.yml` (PR/push CI). Root `README.md` layout + license-table entries (All Rights Reserved, like choices-webapp).

**Schema (0002_core.sql):**
- `sets` — code PK, name, set_type, released_at, card_count, icon_svg_uri.
- `cards` (oracle-level) — `oracle_id uuid PK`, name UNIQUE, mana_cost, mana_value, type_line, oracle_text, colors[], color_identity[], keywords[], power/toughness/loyalty/defense, produced_mana[], layout, legalities jsonb, card_faces jsonb, reserved, edhrec_rank, `is_removed bool` (soft delete), **`content_hash`** (sha256 of canonical fields — drives diffing and Phase 3 re-embeds). No raw Scryfall JSON stored.
- `printings` (slim) — scryfall `id uuid PK`, oracle_id FK, set_code FK, collector_number, rarity, lang, released_at, artist, finishes[], promo, digital, `image_small`/`image_normal` (two URI columns only), prices (usd/usd_foil/eur/tix), `content_hash` **excluding prices** (prices update unconditionally behind `IS DISTINCT FROM`).
- `rulings` — (oracle_id, comment_hash) PK; truncate-and-reload each run in one txn (~70k rows, diffing not worth it).
- `ingest_runs` — the $0 observability layer: source, bulk_updated_at, started/finished, rows inserted/updated/removed, status, error.

**Indexes (0003_search.sql):** generated `search_tsv tsvector` STORED + GIN (name+type_line+oracle_text); `gin_trgm_ops` on name (autocomplete/fuzzy); GIN on keywords, color_identity; btrees on printings(oracle_id), printings(set_code), cards(mana_value), cards(edhrec_rank).

**Ingest algorithm:** (1) `GET api.scryfall.com/bulk-data` with `User-Agent: mtg-api/0.1 (austinjuliuskim@gmail.com)`; skip files whose `updated_at` matches last successful run. (2) Stream JSONL via httpx `iter_lines()`; assert JSONL format on line 1. (3) Oracle pass: filter layouts without stable oracle identity (token, emblem, art_series, double_faced_token); `reversible_card` takes oracle_id from `card_faces[0]`; upsert 500-row batches with `ON CONFLICT (oracle_id) DO UPDATE ... WHERE content_hash IS DISTINCT FROM excluded.content_hash`. (4) Printings pass from default-cards, same hash guard; upsert `sets` first. (5) Removals: TEMP table of seen ids → soft-delete cards not seen; **abort if seen < 90% of current count** (truncated-download guard). (6) Rulings reload. (7) Write `ingest_runs` + `$GITHUB_STEP_SUMMARY`; job failure ⇒ GitHub failure email = the alarm.

**Cron:** `17 9 * * 1,4` (Mon+Thu — deliberately 2×/week: Supabase Free pauses after ~7 idle days and a weekly cron races that window; this keeps warm margin and fresher prices) + `workflow_dispatch` with `sources` input. Uses Supabase **session pooler (5432)** with the `mtg_ingest` role.

**Verify:** `docker compose up -d && DATABASE_URL=... python scripts/migrate.py`; `pytest` (integration test ingests fixtures twice — second run must be a 0-update no-op; mutate one oracle_text → exactly 1 update); CI runs `migrate.py --dry-run`; live: dispatch ingest, then check `count(*) FROM cards` ≈35k and `pg_size_pretty(pg_database_size(...))` in Supabase SQL editor.

**Ops tasks (PR 1):** create Supabase project; create `mtg_ingest` role; set `MTG_DATABASE_URL` repo secret; run first ingest via workflow_dispatch; add vault note `30-projects/MTG Card Database.md`.

## Phase 2 — FastAPI on Lambda (PR 2)

Files: `template.yaml`, `docs/iam-policy.json` (scoped: stack `MtgApi*`, function `mtg-api*`), `src/requirements.txt` (**fastapi, mangum, psycopg[binary] only** — ~18MB zipped, no ORM per repo precedent), `src/mtg_api/{app.py, lambda_handler.py (Mangum), queries.py, routes/{cards.py, sets.py, health.py}}`, `scripts/serve-local.py`, `tests/test_app.py`; deploy job added to `mtg.yml`.

- **Template mirrors `services/guided-repl-api/template.yaml`:** `AWS::Serverless::HttpApi` + one function, `Runtime: python3.12`, `MemorySize: 512` (cold start ~1–1.5s vs ~3s at 256; still $0 at this traffic), `Timeout: 10`, `DatabaseUrl` NoEcho param. First deploy manual with full `--parameter-overrides`; CI deploys with none (UsePreviousValue). Lambda uses Supabase **transaction pooler (6543)**, one connection per invocation.
- **Endpoints v1** (query params, not Scryfall syntax): `GET /v1/cards/{oracle_id}`, `/v1/cards/named?exact=|fuzzy=` (trgm), `/v1/cards/search?q=&color=&identity=&type=&keyword=&mv*=&format=&order=&page=&page_size≤100` (`websearch_to_tsquery` + filters), `/v1/cards/autocomplete?q=`, `/v1/cards/random`, `/v1/cards/{id}/rulings`, `/v1/cards/{id}/printings`, `/v1/sets`, `/v1/sets/{code}`, `/v1/healthz`.
- **OpenAPI `/docs` public** (becomes third-party docs in Phase 5). Root `/` carries the Fan Content Policy attribution. CORS `*`, GET-only.
- **CI:** test job = ruff + pytest (docker Postgres service container) + `migrate.py --dry-run`; deploy job gated on push-to-main, OIDC role `arn:aws:iam::549883968767:role/mtg-api-github-deploy`, `sam build && sam deploy --stack-name MtgApi --region us-west-2 --resolve-s3 ...`, then `migrate.py` against prod.

**Verify:** pytest TestClient; `serve-local.py` + click through `/docs`; after deploy `curl .../v1/cards/named?fuzzy=lightning+bol`, `/v1/healthz`; check cold start <2s in CloudWatch.

**Ops tasks (PR 2):** create IAM role from `docs/iam-policy.json` + OIDC trust; first manual `sam deploy` with full overrides.

## Phase 3 — Similarity / recommendations v1 (PR 3)

Files: `migrations/0004_embeddings.sql`, `src/mtg_api/similar/{embed_text.py, scoring.py}`, `src/mtg_api/routes/similar.py`, `scripts/embed.py`, `scripts/eval_similar.py`, `eval/golden_synergies.yaml`.

- **`card_embeddings`**: `oracle_id PK FK`, `embedding halfvec(512)`, model, `embed_hash`, updated_at + **HNSW `halfvec_cosine_ops`** index. 35k×512×2B ≈ 36MB data + 50–80MB index (ivfflat fallback noted if Free-tier `maintenance_work_mem` can't build HNSW).
- **Embed text:** `"{name→CARDNAME} | {type_line} | {oracle_text, reminder text stripped, self-name→CARDNAME} | keywords: … | stats: … | mv … | colors …"` (faces concatenated for MDFC/split). Self-name replacement kills name-similarity bias; reminder stripping kills keyword-definition noise.
- **Pipeline:** `scripts/embed.py` runs in `mtg-ingest.yml` after ingest, embedding only rows where `embed_hash IS DISTINCT FROM` computed — a typical week is <100 cards ≈ $0.001. Bedrock **Titan Text Embeddings V2** (`dimensions=512, normalize=true`); add `bedrock:InvokeModel` on the foundation-model ARN to the deploy role (IAM pattern precedent: `apps/choices-webapp/template.yaml`); ingest workflow gets OIDC `id-token: write`. Initial full run ~1h, **~$0.10–0.50 one-time**.
- **Hybrid scoring:** top-200 by cosine (prefiltered `is_removed=false`, optional format legality) → rescore: `0.55·cosine + 0.25·keyword/mechanic jaccard + 0.10·type-line overlap + 0.10·shared resource signals (counters/tokens/sacrifice/graveyard regex features)`. Filters: `?identity=` (commander color-identity subset), `?format=`, exclude seed + same-name variants. Weights are constants tuned against the golden set.
- **Confidence 0–1:** calibrate via fixed logistic over z-score against a background distribution of ~10k random pairs (constants checked in). Bands high ≥0.75 / medium ≥0.5 / low. Framed honestly as "confidence of mechanical synergy," not win rate. Response includes cheap structured `reasons` (["shared keyword: Landfall", "high text similarity"]) — key to making unfamiliar suggestions trustworthy.
- **Eval on $0:** `eval/golden_synergies.yaml` (~50 famous synergy pairs: Exquisite Blood↔Sanguine Bond, Basalt Monolith↔Rings of Brighthearth, Heliod↔Walking Ballista, … + ~20 known-bad pairs); `eval_similar.py` reports recall@10/25 + MRR + bad-pair leakage. Gate: recall@10 ≥ 0.5 before shipping publicly; weight changes must not regress it.

**Endpoint:** `GET /v1/cards/{oracle_id}/similar?limit=&format=&identity=&min_confidence=`.

## Phase 4 — Webapp (lighter; PR 4+)

`apps/mtg-webapp/` — Vite + React `^19`, S3+CloudFront copying `apps/guided-repl/template.yaml` (`/api/*` behavior → MtgApi execute-api origin, managed CachingDisabled + AllViewerExceptHostHeader policies), `deploy-frontend.sh` pattern. Pages: search (FTS + filter chips), card page (Scryfall-hotlinked images + attribution, printings/prices, rulings, **similar-cards panel with confidence badges above the fold** — the differentiator), deck-builder skeleton (Moxfield-like, localStorage, no auth yet; deck-level suggestions = identity-filtered union of similar-cards over the list). **Log suggestion impressions/clicks/deck-adds from day one** — this is the future training data. Auth/persistent decks later (Supabase Auth available).

## Phase 5 — Third-party API access (PR 5)

- Keys: `api_keys` table storing **sha256 only** (sessions.js precedent), format `mtg_live_<32hex>`, tiers `free|supporter`, issued manually via `scripts/issue_key.py` until demand exists.
- Rate limiting on budget: **no new WAF ACL** ($6+/mo). (a) Anonymous ceiling via the existing `ops/edge-waf.yaml` ACL associated to the distribution; (b) per-key fixed-window Postgres counter (`INSERT ... ON CONFLICT DO UPDATE SET count=count+1 RETURNING count`) in FastAPI middleware, 429 + Retry-After. Move to DynamoDB counters only if Postgres writes become the bottleneck.
- **Licensing-compliant tiers:** anonymous unkeyed access to all card-data endpoints always exists at a modest limit; paid tiers sell only higher limits + recommendation value-add. Attribution requirements documented in `docs/third-party-api.md`.

## Later / optional — RAG + trained model (honest assessment)

- **Rank/re-rank RAG:** per-request LLM calls are wrong for this budget/latency. Viable shape is **offline**: batch-precompute top-N synergy lists + one-line explanations, cache in Postgres, refresh only changed cards during ingest. Full pass ≈ 35k Haiku-class calls ≈ $10–30 one-time, pennies incremental. Do it when hybrid recall plateaus.
- **Trained suggestion model:** needs labels; co-occurrence scraping would just rebuild EDHREC (explicitly not the goal). Collect own feedback (Phase 4 logging) and **don't train before ~10k feedback events**; first model is a reranker/embedding fine-tune, not an agent. Until then, weight-tuning the hybrid scorer wins on cost and debuggability.

## Cost table (phases 1–3)

| Item | Monthly | Notes |
|---|---|---|
| Supabase Free | $0 | 500MB; kept warm by 2×/wk ingest |
| GitHub Actions (ingest + CI) | $0 | ~150–200 min/mo, under free tier |
| Lambda 512MB | $0 | perpetual free tier 1M req + 400k GB-s |
| API Gateway HttpApi | ~$0–1 | $1/M requests |
| CloudWatch logs (30-day retention) | ~$0 | |
| Bedrock incremental re-embeds | ~$0.01 | changed cards only |
| **Total** | **~$0–2/mo** | one-time: initial embed $0.10–0.50; optional LLM re-rank batch $10–30 |

**500MB arithmetic:** cards ~40MB + FTS/trgm/array GINs 50–80MB + printings 70–110MB + ~30MB indexes + rulings ~20MB + embeddings 36MB + HNSW 50–80MB ⇒ **~250–380MB. Fits, without huge slack.** Levers before paying: derive image URIs from scryfall id (−30–40MB), card_faces only for multiface, 256-dim embeddings (−~45MB).

**Paid inflection points, in order:** (1) DB >500MB or pause-tolerance exhausted → Supabase Pro $25/mo (raise the $35 billing alarm in that PR's Ops tasks); (2) >~1M req/mo → HttpApi+Lambda dollars; (3) dedicated WAF ACL if abuse outgrows shared one; (4) online LLM re-ranking.

## Risks

- **Supabase Free pausing** after ~7 idle days — 2×/wk cron keeps warm; two consecutive failed ingests → pause; failure email is the alarm, unpause is one click, data preserved.
- **Scryfall JSONL format** — verify `jsonl_download_uri` field name at implementation time; assert format on line 1.
- **oracle_id edge cases** — absent on token/art_series layouts (filtered); on `reversible_card` lives in faces; Alchemy `A-` rebalances are new cards (name UNIQUE catches surprises loudly); fixtures cover all.
- **Cold starts ~1s** at 512MB — accepted pre-users; no provisioned concurrency.
- **`MTG_DATABASE_URL` as GH secret** — new CI precedent; scoped `mtg_ingest` role; session pooler (5432) for ingest vs transaction pooler (6543) for Lambda (prepared-statement behavior differs).
- **Licensing is a product constraint:** monetization = rate limits + recommendations, never card data behind a key.

## Key precedent files (reuse, don't reinvent)

- `services/guided-repl-api/template.yaml` — SAM/HttpApi/NoEcho-params shape to mirror
- `services/guided-repl-api/scripts/migrate.js` — migration-runner semantics to port to Python
- `.github/workflows/guided-repl.yml` — CI/OIDC/concurrency/UsePreviousValue patterns
- `services/guided-repl-api/docs/iam-policy.json` — least-privilege deploy-role template
- `apps/choices-webapp/template.yaml` — Bedrock IAM statement pattern
- `docs/adding-a-project.md` — new-area checklist (README, manifest+lockfile, root README table)
