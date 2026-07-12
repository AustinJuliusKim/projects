# guided-repl-api

Accounts & Progress backend for the guided REPL (see the Accounts & Progress
Spec): magic-link auth, anonymous→account progress merge, staged lead
capture, proof-gate events, and the wallet-ledger schema (balance read only —
Stripe/BYOK endpoints are Phase B).

Plain Fastify (`buildApp()` factory) + plain `pg`. Deployed v1 as Lambda
(`src/lambda.js`, `@fastify/aws-lambda` + SAM HttpApi) behind CloudFront's
`/api/*` behavior on learn.austinjuliuskim.com so the `gr_session` cookie is
first-party httpOnly. `src/server.js` + the Dockerfile keep container parity.

## Portability disciplines (locked)

- All reads/writes through this service via plain `pg` — the browser never
  talks to Supabase; migration to Aurora = connection-string swap.
- Schema lives in `migrations/*.sql`, applied by `scripts/migrate.js` —
  never dashboard-edited.
- Auth behind `src/auth/adapter.js` (`issueMagicLink`/`verifyToken`);
  our own `users.id` is the PK everywhere, the Supabase UID is just
  `users.auth_uid`.
- RLS (migration 0004) is defense-in-depth only — authz is enforced in
  `src/app.js`.

## Environment

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Supabase pooler in v1) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | GoTrue admin key (server-side only) |
| `SESSION_TTL_DAYS` | session lifetime, default 30 |
| `COOKIE_SECRET` | reserved for signed cookies |
| `PUBLIC_ORIGIN` | site origin for CORS + magic-link redirect (default `https://learn.austinjuliuskim.com`) |

## Migrations

```sh
node scripts/migrate.js --dry-run          # validate naming/order, no DB
DATABASE_URL=postgres://… npm run migrate  # apply, records schema_migrations
```

## Local dev

```sh
npm ci
DATABASE_URL=postgres://localhost/guided_repl npm run dev   # FAKE_AUTH=1
```

`FAKE_AUTH=1` swaps in `src/auth/fakeAdapter.js`: POST `/api/auth/verify`
with `{"tokenHash": "fake-you@example.com"}` signs in deterministically, no
email sent. The app's vite dev server proxies `/api` → `localhost:3001`.

## Tests

```sh
npm test                                   # app.inject + in-memory repo stub
TEST_DATABASE_URL=postgres://…/guided_repl_test npm test   # + real-pg suite
```

The integration suite drops/recreates the target database's tables — point
it at a throwaway database.

## Deploy (Lambda + SAM)

```sh
sam build
sam deploy --parameter-overrides \
  DatabaseUrl=… SupabaseUrl=… SupabaseServiceRoleKey=… CookieSecret=…
```

Take the `ApiEndpoint` output and set it as the frontend stack's
`ApiOriginDomain` parameter so CloudFront routes `/api/*` here. Container
alternative: `docker build -f services/guided-repl-api/Dockerfile .` from
the repo root.

## Supabase → Aurora swap (runbook sketch)

1. Stand up Aurora Serverless v2 Postgres; run the same `migrations/`.
2. `pg_dump`/`pg_restore` (or logical replication) the data across.
3. Swap `DATABASE_URL` — discipline #1 makes that the whole data cutover.
4. Replace `supabaseAdapter` with a self-rolled magic-link adapter (SES);
   sessions invalidate, users re-login via magic link.
