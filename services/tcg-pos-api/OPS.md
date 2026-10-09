# tcg-pos-api — ops runbook

Manual steps between merged code and a live service. Nothing here has been
done yet; check items off as they are.

## Before any deploy

- [ ] **Replace the `X-Tenant-Id` / `X-Actor` headers with a verified auth
  claim** (Supabase Auth JWT → tenant id + user id), in `deps.py`. Until
  then any caller can act as any tenant; `template.yaml` must not be
  deployed.
- [ ] Pin CORS `allow_origins` in `app.py` to the POS app's origin.

## 1. Database

- [ ] Create a **separate** Supabase project for the POS (not the mtg-api
  one): tenant data and card-catalog data have different blast radii and
  backup needs, and the POS must not be able to break the public catalog.
  `inventory_item.printing_id` already has no cross-DB FK.
- [ ] **Disable the Data API** for the POS Supabase project (Project
  Settings → Data API → off). The POS is only reached through tcg-pos-api;
  PostgREST's `anon`/`authenticated` roles have no business in this schema.
  `0003_supabase_lockdown.sql` also revokes everything from those roles
  (and their default privileges) as a second wall, and enables RLS with no
  policy on `schema_migrations` — but don't rely on that alone.
- [ ] Create a login role to own the schema and run migrations as it
  (as mtg-api does with `mtg_ingest`). `0001_core.sql` creates the
  `tcg_pos_app` NOLOGIN role, so the migrating role needs `CREATEROLE` the
  first time (Supabase's `postgres` has it), or create `tcg_pos_app` by
  hand first.
- [ ] Grant the Lambda's login role membership so `SET LOCAL ROLE` works:
  `GRANT tcg_pos_app TO <login role>;`. The login role should not be a
  superuser or `BYPASSRLS` — the app drops to `tcg_pos_app` regardless,
  but defense in depth.
- [ ] `DATABASE_URL=<session pooler :5432> make migrate`.

## 2. CI / deploy

- [ ] No deploy job exists yet. When added (mirroring `mtg.yml`'s gated
  `deploy` job): a `TCG_POS_DATABASE_URL` repo secret, an OIDC deploy
  role, and a `TCG_POS_DEPLOY_ENABLED` repo variable gate.
- [ ] First `sam deploy` manual with `DatabaseUrl=<transaction pooler :6543>`
  and `MtgApiBase=<deployed mtg-api base URL>`.

## 3. Catalog / prices (mtg-api)

- [ ] `MTG_API_BASE` (SAM parameter `MtgApiBase`) points at the deployed
  `services/mtg-api`. The POS calls its public `/v1/sets`, `/v1/cards/*`
  and `POST /v1/prices/batch`; if mtg-api's rate limiter applies to the
  POS's egress, give the POS a key or an allowlist before stores import.
- [ ] The app needs `VITE_MTG_API_BASE` at build time (card search runs
  in the browser against mtg-api directly).
- [ ] TCGplayer import does one `/v1/sets` call and ⌈rows/200⌉ batch calls
  inside the request. At the 2000-row cap that is 11 mtg-api calls; check
  real latency against the 10 s Lambda timeout (and API Gateway's 30 s)
  before raising either the row cap or the timeout.
- [ ] `DB_CONNECT_TIMEOUT` (default 5 s) must stay below the Lambda
  timeout. Connections already use `prepare_threshold=None` for the
  transaction pooler.
