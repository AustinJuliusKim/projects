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

- **Storefront** — `storefront`, one row per tenant: public `slug`,
  `published`, the web/pickup `location_id`, holdback (`holdback_copies`,
  `holdback_pct`), `reservation_hours`. `web_available(qty, copies, pct)` =
  `greatest(0, qty − greatest(copies, ceil(qty × pct / 100)))` is the one
  holdback rule (orders, quotes and the listings indexer all call it).
  `storefront_by_slug()` / `published_storefronts()` are SECURITY DEFINER
  lookups returning only published rows and public columns.
- **Web orders** — `web_order` / `web_order_line`: reserve-for-pickup
  orders with snapshotted line prices. Status only leaves `reserved`
  (→ `picked_up` | `cancelled` | `expired`), enforced by trigger.
- **Search outbox** — `search_outbox`: triggers on `inventory_item` and
  `storefront` enqueue `(tenant_id, printing_id)` (NULL printing = whole
  store) in the writing transaction and `pg_notify('search_outbox')`. See
  "Listings outbox" below.

Ledger and audit tables reject UPDATE/DELETE/TRUNCATE via triggers, for
every role. Money is integer cents; unknown is NULL, never 0.

Roles: requests run as `tcg_pos_app`; background jobs (listings indexer,
reservation expiry) use `tcg_pos_worker` for cross-tenant bookkeeping
functions and `tcg_pos_app` for tenant data. `search_outbox` and
`storefront_rate_counter` are owner-only tables (RLS enabled, not forced)
reached solely through SECURITY DEFINER functions.

## API

All `/v1` routes except `/v1/health` and the public `/v1/storefront/{slug}`
routes need `X-Tenant-Id: <uuid>`; writes also need `X-Actor`. Both are placeholders until a verified auth claim
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
| `GET /v1/storefront-settings` / `PUT …` | the tenant's storefront (PUT is audit-logged; 409 on a taken slug/domain) |
| `GET /v1/web-orders` | `status`, `page`, `page_size`; newest first, with lines |
| `POST /v1/web-orders/{id}/picked-up` | `reserved` → `picked_up`; 409 otherwise |
| `POST /v1/web-orders/{id}/cancel` | `reserved` → `cancelled`, stock restored (+n ledger, `web_cancel:<id>`); 409 otherwise |

### Public storefront (`/v1/storefront/{slug}`)

No headers: the tenant is resolved from the slug on the server
(`deps.StorefrontConn`); `X-Tenant-Id` is never read. Unknown, unpublished
and malformed slugs are all 404.

| Route | |
| --- | --- |
| `GET /v1/storefront/{slug}` | store name, pickup location, policy/pickup text |
| `GET /v1/storefront/{slug}/offers` | `printing_id` (repeat, ≤ 100) → live offers: priced, `available` = web-available after holdback |
| `POST /v1/storefront/{slug}/cart/quote` | `{lines: [{inventory_item_id, qty, unit_price_cents?}]}` → per line `ok` / `not_found` / `not_priced` / `insufficient` / `price_changed` |
| `POST /v1/storefront/{slug}/orders` | reserve for pickup: `{idempotency_key, customer: {name, email, phone?}, lines}`; 201 new, 200 idempotent replay, 409 `{message, issues}` |
| `GET /v1/storefront/{slug}/orders/{id}?code=` | confirmation page; needs the pickup code |

Placing an order, in one transaction: an advisory lock on the idempotency
key, replay lookup, `FOR UPDATE` on the items in id order, location /
priced / `web_available` checks (any failure → 409, nothing written), then
the order (6-character pickup code, `expires_at = now() +
reservation_hours`) and per line: snapshot price, `qty −= n`, ledger row
(`channel='web'`, `reason='web_reserve:<order id>'`, `actor='web:<email>'`)
and audit row. Caps: ≤ 40 lines, ≤ 20 per line, one line per item. Public
POSTs are rate limited per IP in Postgres (`ratelimit.py`;
`STOREFRONT_ORDER_LIMIT` default 10/min, `STOREFRONT_QUOTE_LIMIT` 60/min).

`storefront.storefront_offers(conn, store, printing_ids)` is the live-offer
query the card page (M6) reuses; `/search` and `/autocomplete` are M6.

Expire stale reservations (same reversal as cancel, status `expired`,
reason `web_expire:<id>`; also prunes old rate-limit windows):
`python -m tcg_pos_api.jobs.expire_reservations` (`make expire-reservations`).

### Listings outbox (consumer contract, for the M5 indexer)

Run as a login role granted `tcg_pos_worker` (claim/ack) and `tcg_pos_app`:

```sql
BEGIN;
SET LOCAL ROLE tcg_pos_worker;
SELECT id, tenant_id, printing_id, created_at FROM claim_search_outbox(500);
-- rebuild each claimed (tenant, printing) — printing_id NULL = whole store —
-- from Postgres and bulk-index it; only once that succeeded:
SELECT ack_search_outbox(ARRAY[...]::bigint[]);   -- deletes them, returns count
COMMIT;
```

`claim_search_outbox(max_rows)` returns the oldest rows (≤ 5000) locked
`FOR UPDATE SKIP LOCKED` in the caller's transaction, so concurrent
consumers get disjoint rows; rollback or a crash releases them for the next
claim (at-least-once). Events carry no state, so duplicates are harmless
and should be coalesced per card. `LISTEN search_outbox` to wake up on
commits.

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
| `STOREFRONT_ORDER_LIMIT` | `10` | public order POSTs per IP per minute |
| `STOREFRONT_QUOTE_LIMIT` | `60` | public cart-quote POSTs per IP per minute |
| `STOREFRONT_RATELIMIT_ENABLED` | `1` | `0` disables the check (local dev only) |

For suggestions and imports locally, run `services/mtg-api` on :8000 against
its own database first (see its README), then `make serve` here.

The DB-backed tests connect as a superuser to seed, and assert isolation
through the API and through direct SQL as `tcg_pos_app`, so RLS is what's
being tested. mtg-api is faked with `httpx.MockTransport` (`FakeMtgApi` in
`tests/conftest.py`); no test touches the network.
