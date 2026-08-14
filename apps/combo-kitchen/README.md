# Combo Kitchen

An 8-bit, Cooking Mama-style browser toy: pick three main ingredients from the
pantry, endure a short cooking ruckus, and out comes a finished dish with a
real quick recipe. Unrecognized combinations produce Mystery Stew — every trio
"works". Discovered dishes are remembered in a local cookbook (localStorage
only; there is no backend).

## Requirements

- Node **>= 24** — `npm test` imports the TypeScript game modules directly via
  Node's type stripping, which older majors don't support. (You may see an
  `ExperimentalWarning` about type stripping; it's harmless.)

## Commands

```sh
npm ci
npm test         # node --test over the pure game logic in src/game/
npm run dev      # vite dev server
npm run build    # tsc -b && vite build
```

## Layout

- `src/game/` — pure, DOM-free game logic and data (ingredients, dish combos,
  matching, cookbook state). This is the only code the tests touch.
- `src/components/` — React UI (pantry, cooking scene, dish reveal, cookbook).
- `src/hooks/useCookbook.ts` — the only code that touches localStorage.

## Deploy

Same S3 + CloudFront pattern as `apps/portfolio`: `template.yaml` +
`deploy-frontend.sh`, driven by `deploy-params.json`. The GitHub workflow's
deploy job skips itself while `RoleArn` is still `FILL_AFTER_BOOTSTRAP`;
bootstrap the stack and OIDC role first, then fill in the real ARN.
