# tcg-pos-api

Backend for the TCG card-shop POS (vault: `30-projects/TCG Store POS.md`).
FastAPI on Lambda (SAM + HttpApi, Mangum) over Supabase Postgres, same
conventions as `services/mtg-api`: `pytest` + `ruff`, per-project `.venv`,
pinned deps in `requirements-dev.txt` (Lambda runtime pins in
`src/requirements.txt`), plain numbered SQL migrations applied by
`scripts/migrate.py`.

Scaffold stage: no deployed stack yet. Auth + RBAC follow
[`docs/AUTH_PLAN.md`](docs/AUTH_PLAN.md) (A1/A2 done: verified access tokens,
Postgres-resolved roles and permissions, invites; Cognito resources are A4).
See [`OPS.md`](OPS.md) before deploying anything.

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
- **Users and roles** — `app_user` (global, keyed by the identity
  provider's `sub`; owner-only, reached through SECURITY DEFINER functions),
  `permission` (the `Perm` enum's keys), `role` (system roles owner /
  manager / buyer / cashier, or a store's own) + `role_permission`,
  `membership` (store × user → role, active | disabled; a store always keeps
  an active owner) and `invite` (only a SHA-256 of the token is stored).
- **Actors** — `inventory_ledger.actor`, `credit_ledger.actor`,
  `audit_log.actor` and `buylist.created_by` default to the transaction's
  `app.actor` (`user:<uuid>`, `job:<name>`, `storefront:<slug>`), and a
  trigger rejects any other value from `tcg_pos_app`: route code never
  passes an actor. `approved_by` works the same way from `app.approved_by`.
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
routes need a credential in `Authorization` (`auth/principal.py`):

| Scheme | Who | Store | Actor |
| --- | --- | --- | --- |
| `Bearer <access token>` | a signed-in person (Cognito; the dev issuer locally) | `X-Tenant-Id: <uuid>` picks one of their stores | `user:<id>` |
| `Device <device secret>` + `X-Register-Session: <token>` | the staff member signed in with their PIN on an enrolled register | the device's store | `device:<id>/user:<id>` |
| `ApiKey tcgpos_<prefix>_<secret>` | a store API key with its own permission list | the key's store | `apikey:<id>` |

`X-Tenant-Id` is only a selector (optional for Device/ApiKey, and must
match). The caller's active membership, role and permissions are read from
Postgres on every request (403 if not a member, the same for a store that
doesn't exist). Each route declares one permission (403
`{"detail": {"missing": "<perm>"}}`); `tests/fixtures/perm_matrix.yaml` is
the role × route table. 401s from Device auth carry `{"detail": {"reason":
"device_unknown" | "session_required" | "session_invalid" | "session_ended"
| "session_expired" | "session_idle", "message": …}}`.

**Approvals.** Some actions are gated by the role's `approval_policy`
(cashiers: refunds, voids, store-credit corrections, price overrides). Such
a route answers 403 `{"detail": {"approval_required": "<perm>",
"amount_cents": n, "payload_hash": "<hex>"}}`; on a register, a manager
enters their PIN (`POST /v1/approvals` with those three values plus
`approver_user_id` and `pin`) and the client retries the identical request
with `X-Approval: <approval_id>` within 60 s. Single use; the server
recomputes the hash, so a changed body or amount needs a new approval. A bad
or used approval adds `"approval_error": "invalid"` to the same 403. The
write's ledger/audit rows record `approved_by`. Today
`POST /v1/customers/{id}/credit/adjust` uses it (`auth/approvals.py`,
`require_or_approval`); POS sale/refund routes will.

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/me` | signed in | user + `stores[]` (no `X-Tenant-Id`) |
| `POST /v1/me/identity` | signed in | `{id_token}`: verified email + name from the Cognito ID token (422 `{"reason": "invalid_id_token"}` otherwise) |
| `POST /v1/stores` | signed in | onboarding: `{name, location_name?}` → new store, caller is owner; 403 `store_limit` past `MAX_OWNED_STORES`, 429 past `STORE_CREATE_LIMIT`/hour |
| `PUT /v1/me/pin` | any member (bearer) | `{pin}`: 6 digits, not trivial → 204 |
| `GET /v1/registers` · `POST …` | `registers.manage` | list; `{location_id, name}` |
| `POST /v1/registers/{id}/enroll` | `registers.manage` | → `{device, device_secret}` (secret shown once) |
| `GET /v1/registers/devices` · `DELETE …/{id}` | `registers.manage` | list; revoke (ends its sessions) |
| `GET /v1/register/staff` | Device | `[{user_id, name, role}]` members with a PIN |
| `POST /v1/register/sessions` | Device | `{user_id, pin}` → `{session_token, expires_at, idle_timeout_seconds, perms, …}`; 403 `wrong_pin` (+`attempts_left`), 423 `pin_locked` (+`retry_after`), 429 |
| `DELETE /v1/register/sessions` | Device + session | sign out / lock → 204 |
| `POST /v1/approvals` | Device + session | `{perm, payload_hash, amount_cents, approver_user_id, pin}` → `{approval_id, expires_at, …}` |
| `POST /v1/api-keys` · `GET …` · `DELETE …/{id}` | `apikeys.manage` | `{name, perms}` → key shown once; list; revoke |
| `GET /v1/roles` | `staff.manage` | roles with their permissions |
| `GET /v1/staff` · `PATCH /v1/staff/{user_id}` · `DELETE …` | `staff.manage` | list; `{role?, status?}`; DELETE = disable |
| `POST /v1/invites` · `GET …` · `DELETE /v1/invites/{id}` | `staff.manage` | invite `{email, role}` (link logged locally, no email yet); list; revoke |
| `POST /v1/invites/accept` | signed in | `{token}`; the invite email must equal the user's verified email |
| `POST /v1/dev/login` | — | `{email, name?}` → dev access + ID token; only with the dev issuer (ENV=local/test) |

Escalation rules: you can only grant (or act on holders of) a role whose
permissions you hold, only owners grant owner, nobody edits their own
membership, and the last active owner can't be disabled or demoted.

Permissions for the routes below: inventory list, pricing rule / suggest
`inventory.read`; adjust `inventory.adjust`; price PATCH
`inventory.price_edit`; import `imports.run`; PUT rule
`pricing.rules_manage`; credit balance `credit.read`, issue
`credit.issue`, redeem `pos.sell` (credit as tender), adjust
`credit.adjust` (approval-gated for cashiers); storefront settings
`storefront.manage`; web orders `web_orders.read` / `web_orders.fulfill`.

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
| `POST /v1/customers/{id}/credit/adjust` | `{delta_cents ≠ 0, reason}`; 409 below 0; may need an approval (above) |
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
| `GET /v1/storefront/{slug}/search` | `q`, `mode=stock\|catalog`, `sort`, `page`, `page_size`, facets → `tcg_search` search response (below) |
| `GET /v1/storefront/{slug}/autocomplete` | `q`, `size` (≤ 20, default 8) → `[{oracle_id, name, image_small?, price_cents?, type_line?, in_stock}]` |
| `GET /v1/storefront/{slug}/cards/{oracle_id}` | `{card, offers, source}`: catalog card + every paper printing, offers LIVE from Postgres |
| `GET /v1/storefront/{slug}/offers` | `printing_id` (repeat, ≤ 100) → live offers: priced, `available` = web-available after holdback |
| `POST /v1/storefront/{slug}/cart/quote` | `{lines: [{inventory_item_id, qty, unit_price_cents?}]}` → per line `ok` / `not_found` / `not_priced` / `insufficient` / `price_changed` |
| `POST /v1/storefront/{slug}/orders` | reserve for pickup: `{idempotency_key, customer: {name, email, phone?}, lines}`; 201 new, 200 idempotent replay, 409 `{message, issues}` |
| `GET /v1/storefront/{slug}/orders/{id}?code=` | confirmation page; needs the pickup code |

Placing an order, in one transaction: an advisory lock on the idempotency
key, replay lookup, `FOR UPDATE` on the items in id order, location /
priced / `web_available` checks (any failure → 409, nothing written), then
the order (6-character pickup code, `expires_at = now() +
reservation_hours`) and per line: snapshot price, `qty −= n`, ledger row
(`channel='web'`, `reason='web_reserve:<order id>'`, actor `storefront:<slug>`)
and audit row. Caps: ≤ 40 lines, ≤ 20 per line, one line per item. Public
POSTs are rate limited per IP in Postgres (`ratelimit.py`;
`STOREFRONT_ORDER_LIMIT` default 10/min, `STOREFRONT_QUOTE_LIMIT` 60/min).

`storefront.storefront_offers(conn, store, printing_ids)` is the live-offer
query; the card page and the listings indexer use it too.

#### Search (OpenSearch via `services/tcg-search`)

The index is for finding things, Postgres is the truth: search reads the
`listings` / `catalog` aliases, the card page's offers come from Postgres.

- `/search` returns `tcg_search.query.search()`'s dict **verbatim**
  (`tcg_search/query/shape.py`): `{mode, q, total, took_ms, page,
  page_size, sort, results[], facets{name: [{value, count, selected,
  label?}]}, query{clauses[]}, warnings[], did_you_mean, corrected}`.
  - `mode=stock` (default): this store's `listings` docs, always with the
    slug's tenant as the first filter and as routing. Results carry
    `in_stock`, `price_cents` (cheapest offer), `tenant_id` and `offers[]`
    (`{printing_id, set, set_name, collector_number, rarity, finish,
    condition, condition_rank, lang, price_cents, available, image_*}`,
    cheapest first, only copies matching copy-level filters).
  - `mode=catalog`: the whole catalog (`printings[]`, `price_cents` = market
    headline), each result annotated with this store's `in_stock` (0 if
    none) and `store_price_cents` (null if none).
  - `q`: free text + Scryfall-style syntax (tcg-search README). Sorts:
    `relevance` `popular` `name` `price_asc` `price_desc` `newest` `mv`.
    `page_size` ≤ 100, `page × page_size` ≤ 2400.
  - Facets, repeat to multi-select (`?set=mh2&set=ltr`; OR within, AND
    across): `set` `rarity` `finish` `condition` (stock only) `price` (band
    keys `0-100` `100-500` `500-2000` `2000-5000` `5000-10000` `10000-`, in
    cents) `colors` `identity` `types` `keywords` `format`.
- `/cards/{oracle_id}`: `card` is shaped like a search result (oracle_text
  as printed, faces, legal, image_*) plus `printings[]` `{id, set_code,
  set_name, collector_number, rarity, finishes, released_at, lang,
  image_small, image_normal}` (paper, newest first); `offers` is
  `{printing_id: [{inventory_item_id, printing_id, game, condition, finish,
  lang, price_cents, available}]}` for printings with web stock;
  `source` is `index`, or `mtg-api` when OpenSearch is down (card data from
  `MTG_API_BASE`). Unknown card → 404.
- OpenSearch down → 503 `search is temporarily unavailable`; alias not
  built yet → 503 `search index is not built yet`.
- Requests under `/api/v1/...` are served as `/v1/...` (same-origin dev
  proxies that don't strip the prefix).

#### Listings indexer (`python -m tcg_pos_api.search.listings`)

`rebuild` (new versioned index from every published store, atomic alias
swap, previous kept, then drains what queued meanwhile), `drain` (until the
outbox is empty), `follow` (LISTEN + 5 s poll, SIGTERM-safe; the local
systemd service `tcg-search-listings`, see `services/tcg-search/OPS.md`
§5), `status` (JSON: backlog, oldest event age, alias, per-store docs). One
writer at a time (advisory lock); acks only after a clean bulk request.
Card data comes from the catalog index's `_source`, never mtg_dev. Design
notes are in the module docstring. `search_outbox_stats()` (migration
0010) backs `status`.

Expire stale reservations (same reversal as cancel, status `expired`,
reason `web_expire:<id>`, actor `job:expire_reservations`; also prunes old
rate-limit windows):
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
| `AUTH_ISSUER` | dev issuer (`make serve`) | exact token `iss`; required by the app |
| `AUTH_CLIENT_IDS` | dev client | comma list of accepted `client_id`s |
| `AUTH_JWKS_URL` | `{issuer}/.well-known/jwks.json` | dev issuer: `.dev/auth/jwks.json` |
| `ENV` | `local` (`make serve`) | the dev issuer is refused unless `local` / `test` |
| `APP_BASE_URL` | `http://localhost:5173` | invite accept links |
| `REGISTER_PIN_LIMIT` | `10` | PIN attempts per register device per minute |
| `MAX_OWNED_STORES` | `5` | stores one user may own (`POST /v1/stores`) |
| `STORE_CREATE_LIMIT` | `3` | `POST /v1/stores` per user per hour |
| `STOREFRONT_ORDER_LIMIT` | `10` | public order POSTs per IP per minute |
| `STOREFRONT_QUOTE_LIMIT` | `60` | public cart-quote POSTs per IP per minute |
| `STOREFRONT_RATELIMIT_ENABLED` | `1` | `0` disables the check (local dev only) |

| `OPENSEARCH_URL` | `http://localhost:9200` | storefront search + listings indexer (`OPENSEARCH_USER` / `_PASSWORD` / `_VERIFY` too) |
| `TCG_SEARCH_PREFIX` | — | index/alias prefix; tests only |

For suggestions and imports locally, run `services/mtg-api` on :8000 against
its own database first (see its README), then `make serve` here.

### Local storefront dev (`tcg_pos_dev` + the demo store)

A persistent dev database `tcg_pos_dev` on the WSL Postgres (:54329) holds a
seeded demo store (`/s/demo`, ~690 items over 355 real cards), and the
`tcg-search-listings` service keeps its `listings` docs current. To serve
the API for the storefront app (Vite on :5175 proxies `/api` → :8001):

```bash
DATABASE_URL=postgres://tcg_pos_worker_login:tcg_pos_worker_login@localhost:54329/tcg_pos_dev \
OPENSEARCH_URL=http://localhost:9200 MTG_API_BASE=http://localhost:8000 \
  .venv/bin/python scripts/serve-local.py        # or: make serve-dev  -> http://127.0.0.1:8001/docs
curl -s localhost:8001/v1/storefront/demo/search?q=bolt
```

Staff routes need a token. `make serve` / `serve-dev` run with the local dev
issuer (key pair generated into `.dev/auth/`, gitignored). After migrating,
make a dev user the demo store's owner once, then mint tokens for it:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:54329/tcg_pos_dev \
  .venv/bin/python scripts/backfill_owner.py --tenant <demo tenant id> --email owner@demo.test
TOKEN=$(.venv/bin/python scripts/dev_token.py owner@demo.test)   # or POST /v1/dev/login
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: <demo tenant id>" localhost:8001/v1/inventory
```

Register mode locally (owner token as above):

```bash
H=(-H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: <demo tenant id>" -H "Content-Type: application/json")
curl -s -X PUT "${H[@]}" localhost:8001/v1/me/pin -d '{"pin":"284716"}'
REG=$(curl -s -X POST "${H[@]}" localhost:8001/v1/registers -d '{"location_id":"<location id>","name":"Front"}' | jq -r .id)
SECRET=$(curl -s -X POST "${H[@]}" localhost:8001/v1/registers/$REG/enroll | jq -r .device_secret)
curl -s -H "Authorization: Device $SECRET" localhost:8001/v1/register/staff   # pick a user_id
SESSION=$(curl -s -X POST -H "Authorization: Device $SECRET" -H "Content-Type: application/json" \
  localhost:8001/v1/register/sessions -d '{"user_id":"<user id>","pin":"284716"}' | jq -r .session_token)
curl -s -H "Authorization: Device $SECRET" -H "X-Register-Session: $SESSION" localhost:8001/v1/inventory
```

Another store: `DATABASE_URL=postgres://postgres:postgres@localhost:54329/tcg_pos_dev
.venv/bin/python scripts/seed_demo_store.py --slug other` (needs a role
that may insert tenants; refuses non-`tcg_pos_dev` URLs). The follower
indexes it within seconds. `make listings-status` shows the outbox and
index state.

The DB-backed tests connect as a superuser to seed, and assert isolation
through the API and through direct SQL as `tcg_pos_app`, so RLS is what's
being tested. mtg-api is faked with `httpx.MockTransport` (`FakeMtgApi` in
`tests/conftest.py`), and so is OpenSearch (`tests/fake_opensearch.py`); no
unit test touches the network. `TEST_OPENSEARCH_URL=http://localhost:9200`
adds `tests/test_listings_os.py`, which builds `itest_<uuid>_*` indices on
the real cluster (deleted afterwards; the live aliases are never touched).
