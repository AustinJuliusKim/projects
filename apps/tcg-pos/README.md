# tcg-pos

Counter/back-office frontend for the TCG card-shop POS
(`services/tcg-pos-api`). Vite + React 19 + Mantine, same conventions as
`apps/mtg-webapp`. Scaffold stage: one Inventory page reading
`GET /v1/inventory`; no auth, no deploy stack yet.

## Develop

```bash
npm ci
npm test        # node --test over the pure modules (money, api)
npm run dev     # http://localhost:5173, proxies /api → localhost:8000
```

Run the API locally first (`services/tcg-pos-api`: `make up migrate serve`).
`VITE_API_BASE` overrides the API base (default same-origin `/api`).
