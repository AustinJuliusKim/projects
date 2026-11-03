# stratboard

A Valorant strategy planner with a built-in randomizer, built as a portfolio
piece.

- **Tactical plan:** picks a map from your pool, a side, a target site, a
  strat (fast execute, split, fake or default on attack; standard, stack,
  aggressive or retake on defense) and a five-agent comp. Each player gets a
  position, a job and a real ability, all drawn on the actual minimap.
- **Strat roulette:** one-round constraints ("Sheriff squad", "Give it up")
  filtered by side. You can also add one to a plan as a twist.
- **Planner:** a ValoPlant-style board on the minimap. Place ally and enemy
  agents and their abilities, draw freehand, arrows and areas, add text, and
  split a round into steps (a new step starts as a copy of the current one).
  It has undo/redo and keyboard shortcuts (V/D/A/C/T/E, Del, Ctrl+Z), and
  exports to PNG. "Edit in planner" turns any generated plan into a board.

Boards autosave in the browser. **Share** copies a link with the whole board
compressed into the URL (deflate + base64url), so nothing is stored on a
server. A shared board is untrusted input: `cleanBoard` rebuilds every item
from known fields, caps item and step counts, and decompression stops at
1 MB.

Each result is seeded and lives in the URL hash, so a copied link reproduces
the same plan as long as the agent and map data haven't changed.

## Data

Maps, callouts (with minimap coordinates) and agents come from the community
[valorant-api.com](https://valorant-api.com). The app fetches them live on
load and falls back to `src/data/snapshot.json`; run `npm run snapshot` to
refresh it.

Routes aren't hand-written. `src/lib/geometry.js` treats a site's callouts
that sit nearer attacker spawn than the site itself as approaches, and the
rest as hold positions. Straight-line distance gets a few sites wrong, and
`ENTRY_OVERRIDES` corrects those.

## Develop

```bash
npm ci
npm test        # node --test over src/lib (rng, data, geometry, plan, roulette, share, board)
npm run dev     # http://localhost:5173
npm run build
```

## Deploy

Static SPA with no backend, hosted on Cloudflare Pages (free tier).
`.github/workflows/stratboard-deploy.yml` deploys every push to main that
touches this app to the `stratboard` Pages project, using the repo's existing
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets. Routing is
hash-based, so Pages needs no rewrite rules.

Fan project, not affiliated with Riot Games.
