# tcg-pos-api — ops runbook

Manual steps between merged code and a live service. Nothing here has been
done yet; check items off as they are.

## Before any deploy

`template.yaml` now defines the Cognito pool and wires `AUTH_ISSUER` /
`AUTH_CLIENT_IDS` / `ENV`, but it is still **not ready to deploy** until
the unchecked items below and in §1b (tcg_search in the bundle, OpenSearch)
are done.

- [x] Replace the `X-Tenant-Id` / `X-Actor` headers with a verified access
  token + Postgres-resolved membership (docs/AUTH_PLAN.md A1/A2, done
  2026-10-14). X-Tenant-Id is now only a store selector.
- [x] Identity provider in `template.yaml` (AUTH_PLAN A4, 2026-10-14): see
  §0 for the steps to stand it up. The app refuses to start without
  `AUTH_ISSUER`, and refuses the dev issuer unless `ENV` is `local`/`test`
  — the template's `Environment` parameter only allows `prod`/`staging`.
- [x] Users' email for invites: the app posts the Cognito ID token to
  `POST /v1/me/identity` after sign-in (A4); the API verifies it and stores
  the verified email. (A5 must make the app do this.)
- [ ] Invite email delivery (SES, §0). Today the accept link is only logged,
  and only in local/test.
- [ ] Existing stores need an owner: `scripts/backfill_owner.py --tenant
  <id> --email <email> --sub <cognito sub>` once per store migrated past
  `0011_rbac`.
- [ ] Pin CORS `allow_origins` in `app.py` to the POS app's origin.

## 0. Sign-in (Cognito) — not done; run manually when deploying

- [ ] Deploy parameters: `CognitoDomainPrefix` (globally unique, e.g.
  `tcg-pos-auth`), `AppCallbackUrls` (e.g.
  `https://pos.example.com/auth/callback`), `AppLogoutUrls`, `AppBaseUrl`
  (invite links), `Environment=prod`. The pool is Lite tier
  (`UserPoolTier: LITE`, free up to the MAU allowance), email sign-in with
  self-signup and email verification, `DeletionProtection: ACTIVE` and
  `DeletionPolicy: Retain` (deleting the stack never deletes users).
- [ ] From the stack outputs, set the app's build env: `VITE_COGNITO_DOMAIN`
  (`HostedUiDomain`), `VITE_COGNITO_CLIENT_ID` (`UserPoolClientId`), and
  the redirect URI matching one of `AppCallbackUrls`. The SPA must use the
  authorization-code flow with PKCE (S256), like
  `apps/choices-webapp/frontend/src/lib/auth.js`.
- [ ] **SES for email** before real stores onboard: Cognito's default sender
  is capped at ~50 emails/day (sign-up codes and password resets). Verify
  a sending domain in SES (DKIM), request production access (out of the
  sandbox), then set the pool's `EmailConfiguration` to
  `EmailSendingAccount: DEVELOPER` + `SourceArn` (+ `From`). Invite mail
  is a separate sender in the API (`routes/staff.deliver_invite`, still a
  log line): give the Lambda `ses:SendEmail` on that identity and wire it.
- [ ] **Google sign-in (optional):** create an OAuth client (Web
  application) in Google Cloud with redirect URI
  `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`,
  then pass `GoogleClientId` / `GoogleClientSecret`. Account linking: a
  Google sign-in is a **different Cognito user (different `sub`)** from an
  email+password user with the same address. The API keys users on `sub`
  and never merges accounts by email, so that person has two app users;
  invites still work for whichever one they accept with (the invite
  matches the verified email). Do not add a pre-sign-up trigger that
  auto-links by email — that lets anyone who controls a Google account for
  an address take over the password account. If linking is ever wanted,
  do it explicitly (AdminLinkProviderForUser) after the user proves both.
- [ ] After the first deploy, backfill owners (above) using the real
  Cognito `sub`s (`aws cognito-idp list-users`, read-only).

## Registers, PINs and API keys — runbooks

**Enroll a register** (a manager or owner, on the register machine):
1. Sign in to the POS app on that machine with your own account.
2. Create the register if needed (`POST /v1/registers {location_id, name}`)
   and enroll this machine (`POST /v1/registers/{id}/enroll`). The
   response's `device_secret` is shown once; the app stores it locally and
   sends `Authorization: Device <secret>` from then on. Sign out of your
   own account on that machine afterwards.
3. Each staff member sets a 6-digit PIN for the store from their own
   sign-in (`PUT /v1/me/pin`), then picks their name on the register and
   enters it. Sessions last 12 h and lock after 30 min idle.

**Lost or stolen register:** `DELETE /v1/registers/devices/{id}` (the app's
registers page once A5 has one). The secret and every session on it stop working on
the next request. Re-enroll the replacement.

**Locked PIN:** 5 wrong PINs lock it for 1 min, then 2, 4, … up to 1 h. The
member can clear it by setting a new PIN from their own sign-in. PIN
attempts are also limited per register (`REGISTER_PIN_LIMIT`, default 10
per minute). Failed attempts are in `audit_log` (`action = 'pin.fail'`).

**Approvals:** by default a cashier needs a manager's PIN for refunds,
voids, store-credit corrections and price overrides (`approval_policy`
rows with `tenant_id IS NULL`). A store can override per role with its own
row (`mode` allow / approval / deny, optional `limit_cents`) — there is no
API for that yet, so it's SQL as the schema owner.

**API keys** (owners): `POST /v1/api-keys {name, perms}` returns the key
once (`tcgpos_<prefix>_<secret>`; only a hash is stored). Keys don't
expire and keep working if their creator leaves — revoke them
(`DELETE /v1/api-keys/{id}`) when the integration or its owner goes away.
Keys can't hold staff/roles/registers/keys/approval/billing permissions.

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
- [ ] `0006`/`0008` create `SELECT` policies scoped `TO` the migrating role
  (`definer_published_read` on `storefront`, `definer_due_read` on
  `web_order`) so the SECURITY DEFINER lookups work without BYPASSRLS.
  They name whoever ran the migration: always migrate as the schema
  owner, and if ownership ever moves, re-create those two policies for
  the new owner.

## 1b. Storefront and background jobs

- [ ] Background jobs (reservation expiry now, the listings indexer in M5)
  need a login role granted both NOLOGIN roles:
  `GRANT tcg_pos_worker, tcg_pos_app TO <job login role>;` — not the
  schema owner, not BYPASSRLS. `0006` creates `tcg_pos_worker` (needs
  `CREATEROLE` the first time, like `tcg_pos_app`).
- [ ] Schedule `python -m tcg_pos_api.jobs.expire_reservations` every ~5
  minutes (systemd timer locally; EventBridge → Lambda if deployed). It is
  idempotent and exits 1 if any order failed to release.
- [ ] **Before a storefront goes public:** reservations need no payment, so
  stock can be tied up by anyone. Per-IP limits (`STOREFRONT_ORDER_LIMIT`,
  `STOREFRONT_QUOTE_LIMIT`), caps (40 lines × 20), expiry and staff cancel
  mitigate it; add email verification or a captcha first. Behind
  CloudFront the IP bucket is the edge IP (see `ratelimit.client_ip`).
- [ ] Pin CORS for the storefront's origin as well as the POS app's.
- [ ] **Storefront search needs OpenSearch and `tcg_search` in the bundle.**
  `routes/storefront.py` and the listings indexer import `tcg_search`
  (services/tcg-search), which `sam build` (CodeUri `src/`) does not
  include, and there is no hosted OpenSearch (local-only by decision, plan
  §1). Before any deploy: vendor tcg-search or build it as a wheel into the
  bundle (plus `pyyaml`), choose hosting, and set `OPENSEARCH_URL` /
  `OPENSEARCH_USER` / `OPENSEARCH_PASSWORD`.
- [ ] The listings indexer (`python -m tcg_pos_api.search.listings
  follow`) is a long-running LISTEN consumer, not a Lambda: run it where a
  process can stay up (or switch to a scheduled `drain`), as a login granted
  `tcg_pos_worker, tcg_pos_app`, after one `rebuild`. Locally it is the
  systemd unit `tcg-search-listings` (services/tcg-search/OPS.md §5) with
  login `tcg_pos_worker_login` on `tcg_pos_dev` — done 2026-10-10.

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
