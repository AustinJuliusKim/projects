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
- **Price rule** — `price_rule`, one row per tenant (none = defaults):
  condition multipliers in basis points (NM 100%, LP 90%, MP 75%, HP 60%,
  DMG 40%), a floor (`min_price_cents`, default 25) and a round-up step
  (`round_up_to_cents`, default 25). Suggested price =
  `max(ceil_to_step(round_half_up(reference × bp / 10000)), floor)`.

Ledger and audit tables reject UPDATE/DELETE/TRUNCATE via triggers, for
every role. Money is integer cents; unknown is NULL, never 0.

## API

All `/v1` routes except `/v1/health` need `X-Tenant-Id: <uuid>`; writes
also need `X-Actor`. Both are placeholders until a verified auth claim
replaces them (see OPS.md).

| Route | |
| --- | --- |
| `GET /v1/health` | DB ping |
| `GET /v1/inventory` | `location_id`, `printing_id`, `page` (≤ 100000), `page_size` |
| `POST /v1/inventory/adjust` | upsert at grain, apply signed `delta`; 409 if qty would go below 0 or past 2³¹−1; optional `price_cents` sets the price in the same transaction |
| `PATCH /v1/inventory/{id}` | `{"price_cents": int \| null}`; audit row, no ledger row |
| `POST /v1/inventory/import/tcgplayer` | TCGplayer inventory CSV body; `location_id`, `dry_run` (default `true`) — see below |
| `GET /v1/pricing/rule` / `PUT /v1/pricing/rule` | the tenant's price rule (PUT is audit-logged) |
| `GET /v1/pricing/suggest` | `printing_id`, `finish`, `condition`, `lang` → suggested cents + provenance |
| `GET /v1/customers/{id}/credit` | balance in cents |
| `POST /v1/customers/{id}/credit/issue` | `amount_cents > 0` |
| `POST /v1/customers/{id}/credit/redeem` | 409 if the balance would go below 0 |

### Prices (mtg-api)

The catalog and prices come from `services/mtg-api` over HTTP
(`catalog.py`, base `MTG_API_BASE`); any mtg-api failure is a 502 naming
it. `/pricing/suggest` takes the open-lane USD reference —
`mtgjson_tcgplayer_retail_usd`, else `scryfall_usd_trend_usd` — from the
NM SKU, applies the tenant's rule, and returns `suggested_cents` (null when
there is no USD price, never 0) with `reference_source`, `snapshot_id`,
`stale` and `attribution` so the UI can show where the number came from.

### TCGplayer import

Body: the seller portal's inventory export (`Content-Type: text/csv`, ≤ 2 MB,
≤ 2000 rows). Column mapping and parsing rules are in `tcgplayer.py`; in
short: only `Product Line` = Magic rows; `Set Name` → set code by exact
(case-insensitive) name via mtg-api `/v1/sets`; set + `Number` + finish →
printing via one batched price lookup; `Condition` ("Lightly Played Foil",
"Near Mint Etched", "Near Mint - Japanese") → condition/finish/lang;
`Total Quantity`; `TCG Marketplace Price` → cents via Decimal.

Apply **sets** each listed grain's quantity to the CSV's Total Quantity
(the ledger records the difference, channel `tcgplayer`, reason
`tcgplayer import`) and its price to the marketplace price when present.
Re-applying the same file is therefore a no-op, not a doubling; grains not
in the file are untouched. Everything applies in one transaction. Known
limit: a printing mtg-api has no price SKU for can't be matched (the batch
lookup is the only set+number resolver mtg-api exposes).

## Develop

```bash
make install        # create .venv, install pinned dev deps
make up             # local Postgres on :54330
make migrate        # apply migrations to the local db

make lint
make test           # DB-backed suites skip without TEST_DATABASE_URL
make test-db        # same, incl. DB-backed tests (drops the db's public schema)
make serve          # http://127.0.0.1:8001/docs (mtg-api expected on :8000)
```

| Env | Default | |
| --- | --- | --- |
| `DATABASE_URL` | — | required |
| `MTG_API_BASE` | `http://localhost:8000` | mtg-api for catalog + prices |
| `DB_CONNECT_TIMEOUT` | `5` | seconds; keep below the Lambda timeout |
| `PORT` | `8001` | `make serve` only |

For suggestions and imports locally, run `services/mtg-api` on :8000 against
its own database first (see its README), then `make serve` here.

The DB-backed tests connect as a superuser to seed, and assert isolation
through the API and through direct SQL as `tcg_pos_app`, so RLS is what's
being tested. mtg-api is faked with `httpx.MockTransport` (`FakeMtgApi` in
`tests/conftest.py`); no test touches the network.
