# tcg-pos

Counter/back-office frontend for the TCG card-shop POS
(`services/tcg-pos-api`). Vite + React 19 + Mantine, same conventions as
`apps/mtg-webapp`. No auth and no deploy stack yet: tenant, location and
clerk are typed into the bar at the top.

Pages:

- **Inventory** — `GET /v1/inventory`, optionally filtered to a location.
- **Receive** — search the catalog (mtg-api, called directly), pick the
  printing / finish / condition / quantity, see the store's suggested price
  (`GET /v1/pricing/suggest`), and add the stock with a price in one
  `POST /v1/inventory/adjust`.
- **Import** — upload a TCGplayer inventory export, preview the dry run
  (matched / unmatched rows, what changes), then apply.

Pure logic (money, query building, form validation, import summaries) lives
in `src/*.js` and is tested with `node --test`; the `.jsx` pages stay thin.

## Develop

```bash
npm ci
npm test        # node --test over the pure modules
npm run dev     # http://localhost:5173, proxies /api → localhost:8001
```

Run both backends locally first:

- `services/mtg-api` on :8000 (catalog + prices; its CORS is open).
- `services/tcg-pos-api` on :8001 (`make up migrate serve`, with
  `MTG_API_BASE=http://localhost:8000`).

| Env | Default | |
| --- | --- | --- |
| `VITE_API_BASE` | `/api` | POS API base (dev server proxies `/api` → :8001) |
| `VITE_MTG_API_BASE` | `http://localhost:8000` | mtg-api base for card search/printings |
