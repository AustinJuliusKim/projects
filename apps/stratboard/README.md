# stratboard

A Valorant strategy randomizer, built as a portfolio piece. It is the first
part of a ValoPlant-style planner; the hand-drawn board comes later.

- **Tactical plan:** picks a map from your pool, a side, a target site, a
  strat (fast execute, split, fake or default on attack; standard, stack,
  aggressive or retake on defense) and a five-agent comp. Each player gets a
  position, a job and a real ability, all drawn on the actual minimap.
- **Strat roulette:** one-round constraints ("Sheriff squad", "Give it up")
  filtered by side. You can also add one to a plan as a twist.

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
npm test        # node --test over src/lib (rng, data, geometry, plan, roulette, share)
npm run dev     # http://localhost:5173
npm run build
```

Static SPA with no backend. It isn't deployed yet.

Fan project, not affiliated with Riot Games.
