# mtg-webapp

Search and deck-building frontend for the MTG card database
(`services/mtg-api`). Vite + React 19 SPA on private S3 + CloudFront, with
`/api/*` forwarded same-origin to the mtg-api HttpApi. The differentiating
feature — mechanically synergistic **similar-card suggestions with
confidence badges and reasons** — sits above the fold on every card page,
and the deck builder aggregates them into deck-level suggestions filtered by
the deck's color identity.

Suggestion impressions/clicks/deck-adds are logged (anonymously) to
`POST /api/v1/feedback/suggestions` from day one — the training data the
eventual recommendation model needs (`services/mtg-api/docs/PLAN.md`).

Deck state is localStorage-only for now; accounts/persistence come later.

## Develop

```bash
npm ci
npm test        # node --test over the pure modules (deck, api, feedback)
npm run dev     # http://localhost:5173, proxies /api → localhost:8000
```

Run the API locally first (`services/mtg-api`: docker compose up, migrate,
ingest, `python scripts/serve-local.py`).

## Deploy

One-time bootstrap and the CI deploy gate are documented in
[`../../services/mtg-api/OPS.md`](../../services/mtg-api/OPS.md)
(section 4). Summary: fill `deploy-params.json` (`ApiOriginDomain` = the
MtgApi stack's `ApiEndpoint` output; domain/cert optional), deploy
`template.yaml`, run `./deploy-frontend.sh`, then set the repo variable
`MTG_WEBAPP_DEPLOY_ENABLED=true` so CI deploys on push to main.

## Attribution

Card data © Wizards of the Coast, provided by [Scryfall](https://scryfall.com).
Unofficial Fan Content permitted under the Wizards of the Coast Fan Content
Policy; not endorsed by Scryfall or Wizards of the Coast.
