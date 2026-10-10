# tcg-storefront

Public web storefront for a card shop on the TCG POS: search the store's
stock (or the whole catalog), see live offers on a card page, and reserve a
cart for in-store pickup. No payment is taken online.

Vite + React 19 + Mantine + react-router. It talks only to the public
storefront API in `services/tcg-pos-api` (`/v1/storefront/{slug}`); search
and autocomplete are served by `services/tcg-search` behind that API.

## Run against the local backend

1. Start the API on :8001 (see `services/tcg-pos-api/README.md`, `make serve`)
   with OpenSearch up and the listings index built, and a published storefront
   (the seeded demo store's slug is `demo`).
2. Start the storefront:

   ```sh
   npm ci
   npm run dev        # http://localhost:5175
   ```

3. Open <http://localhost:5175/s/demo>.

The dev server proxies `/api/*` to `http://127.0.0.1:8001/*` (the `/api`
prefix is stripped), as in `apps/tcg-pos`. Set `VITE_API_BASE` to call
another API origin directly.

```sh
npm test           # node --test, pure modules only, no network
npm run build      # production bundle in dist/
```

## Routes

| Path | Page |
| --- | --- |
| `/s/:slug` | Home: search, popular in stock, new arrivals |
| `/s/:slug/search` | Results grid, facet sidebar, query chips, sort, paging, stock/catalog toggle |
| `/s/:slug/card/:oracleId` | Card text, printings, live offer table, add to cart |
| `/s/:slug/cart` | Cart, re-quoted against live stock on load and on every change |
| `/s/:slug/checkout` | Name / email / phone, reserve (`POST /orders`) |
| `/s/:slug/order/:id?code=` | Confirmation with the pickup code |

Search state lives in the URL, and the URL params are the API params:
`q`, `mode` (`stock` or `catalog`), `sort`, `page`, `page_size`, plus one
repeated param per facet value (`set=lea&set=leb&colors=R`).

## Layout

Response handling is kept in pure modules that `node --test` covers against
fixtures copied from the backend's response shapes (`test/fixtures.js`):

- `api.js`: endpoint paths, query building (repeated facet params), errors (including the 409 `{message, issues}`).
- `searchState.js`: URL ↔ state ↔ API request.
- `facets.js`: facet and value labels, multi-select toggling, chips from the echoed `query.clauses`.
- `cart.js`: per-store localStorage cart reducer, quote merge and issue text, order body, idempotency attempts.
- `card.js`: the offer table rows from `{card, offers}`.
- `money.js`: integer cents → display; null and bad values render as a dash.
- `seo.js`: per-route title, meta description and canonical link.

Checkout generates one idempotency key per attempt and keeps it (in
sessionStorage) across retries of the same cart. A changed cart gets a new
key, because the server rejects a reused key for a different cart.

Card images are Scryfall URLs from the API, hotlinked and never rehosted.
`CardGrid` and the search URL-state pattern are adapted from
`apps/mtg-webapp`. They should move to a shared package once the branches
merge.
