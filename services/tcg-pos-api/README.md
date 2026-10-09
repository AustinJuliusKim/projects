# tcg-pos-api

Backend for the TCG card-shop POS (vault: `30-projects/TCG Store POS.md`).
FastAPI on Lambda (SAM + HttpApi, Mangum) over Supabase Postgres, same
conventions as `services/mtg-api`: `pytest` + `ruff`, per-project `.venv`,
pinned deps in `requirements-dev.txt` (Lambda runtime pins in
`src/requirements.txt`), plain numbered SQL migrations applied by
`scripts/migrate.py`.

Scaffold stage: no auth and no deployed stack yet. See [`OPS.md`](OPS.md)
before deploying anything.

## Data model

- **Tenancy** — `tenant`, `location`, `register`. Every tenant table has
  RLS enabled and forced, with policy `tenant_id = current_tenant_id()`
  (the transaction-local `app.tenant_id` GUC). Requests run as the NOLOGIN
  role `tcg_pos_app` (`SET LOCAL ROLE`), which has no DELETE anywhere.
- **Inventory** — `inventory_item` at the grain tenant × location × game ×
  printing × condition × finish × language. `printing_id` is the Scryfall
  printing id from the catalog (mtg-api's database), deliberately without
  an FK. Every quantity change is an append-only `inventory_ledger` row.
  `game` is `mtg` only for now (CHECK); `lang` is a lowercase 2–3 letter
  code (`en`, `ja`, `zhs`), lower-cased by the API before validation.
- **Store credit** — `customer`, append-only `credit_ledger`, balance via
  the `customer_credit_balance` view.
- **Buylist** — `buylist`, `buylist_offer` (schema only for now).
- **Audit** — append-only `audit_log` with before/after JSON snapshots.

Ledger and audit tables reject UPDATE/DELETE/TRUNCATE via triggers, for
every role. Money is integer cents; unknown is NULL, never 0.

## API

All `/v1` routes except `/v1/health` need `X-Tenant-Id: <uuid>`; writes
also need `X-Actor`. Both are placeholders until a verified auth claim
replaces them (see OPS.md).

| Route | |
| --- | --- |
| `GET /v1/health` | DB ping |
| `GET /v1/inventory` | `location_id`, `printing_id`, `page`, `page_size` |
| `POST /v1/inventory/adjust` | upsert at grain, apply signed `delta`; 409 if qty would go below 0 |
| `GET /v1/customers/{id}/credit` | balance in cents |
| `POST /v1/customers/{id}/credit/issue` | `amount_cents > 0` |
| `POST /v1/customers/{id}/credit/redeem` | 409 if the balance would go below 0 |

## Develop

```bash
make install        # create .venv, install pinned dev deps
make up             # local Postgres on :54330
make migrate        # apply migrations to the local db

make lint
make test           # DB-backed suites skip without TEST_DATABASE_URL
make test-db        # same, incl. DB-backed tests (drops the db's public schema)
make serve          # http://127.0.0.1:8000/docs
```

The DB-backed tests connect as a superuser to seed, and assert isolation
through the API and through direct SQL as `tcg_pos_app`, so RLS is what's
being tested.
