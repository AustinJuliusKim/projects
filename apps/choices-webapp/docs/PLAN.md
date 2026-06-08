# Plan: Two-Player "Elimination" Game Web App

## Context

We want a lightweight web app for a turn-based elimination game between two
players:

1. **User A** pre-seeds 4 choices and gets a shareable link (`/g/{game_id}`).
2. **User B** opens the link, sees the 4 choices, eliminates 1.
3. **User A** is notified automatically, sees the elimination, eliminates 1 (now 2 left).
4. **User B** is notified automatically, eliminates 1 (now 1 left).
5. Both players are shown the winning choice.

Turn order of eliminations: **B → A → B**, leaving exactly 1 winner.

Key constraints from discussion:
- **No formal/relational DB** — use a serverless KV store (DynamoDB).
- **As lightweight & low-cost as possible** — chose the AWS stack with the
  lowest cost surface (perpetual free tier, zero idle cost).
- **Automatic notifications without either player tapping share** — chose
  **Web Push** (free, no Twilio/SMS cost). SMS APIs were rejected because none
  are free for automatic sending.
- **Ports well across Web / Mobile / SMS messaging** — responsive PWA; the
  game link itself is what flows through any messaging app.

## Chosen Stack (lowest cost, fully serverless)

| Concern | Choice | Why |
|---|---|---|
| Game state | **DynamoDB** (on-demand, TTL) | Serverless KV; 25GB perpetual free tier; auto-expire old games |
| Logic | **Lambda Function URLs** | 1M req/mo perpetual free; no idle cost; skips API Gateway |
| Frontend | **Static SPA on S3 + CloudFront** | 1TB/mo CloudFront egress free; pennies storage |
| Notifications | **Web Push (VAPID + `web-push`)** sent from Lambda | Free, automatic, no phone numbers |
| In-app refresh | **Polling** (every ~3s while game open) | Turn-based → no need for websockets/AppSync |
| Deploy / IaC | **AWS SAM** (`template.yaml` → `sam deploy`) | Simplest for Lambda+DynamoDB scope |

> iOS caveat: Web Push on iPhone requires the user to **Add to Home Screen**
> (PWA install, iOS 16.4+). The UI will detect iOS Safari and show a one-time
> "Add to Home Screen to get turn alerts" hint. Push is best-effort; the game
> is always fully playable by reopening the link even if push is denied.

## Data Model (single DynamoDB table)

Table `choices-games`, partition key `pk` (string).

Game item:
```
pk:          "GAME#{game_id}"
choices:     ["Pizza", "Tacos", "Sushi", "Ramen"]   # original 4
eliminated:  [{ index, by, at }]                      # ordered eliminations
turn:        "B" | "A" | "B" | "done"                # whose move next
status:      "active" | "complete"
winnerIndex: number | null
createdAt:   epoch
ttl:         epoch + 30 days                          # DynamoDB TTL auto-delete
```

Push subscription items (one per player who opts in):
```
pk:          "SUB#{game_id}#{role}"   # role = "A" | "B"
subscription: { endpoint, keys: { p256dh, auth } }   # from PushManager
ttl:          same 30-day expiry
```

Player identity is by **role (A/B)** scoped to the game — no accounts/login.
Role is assigned by URL: creator = A; first opener of the share link = B.
A lightweight `localStorage` token per game prevents the wrong side from
re-claiming a role on refresh.

## API (Lambda Function URLs, JSON over HTTPS)

One Lambda, internal routing by `action` (keeps it to a single function/URL):

| Action | Body | Effect |
|---|---|---|
| `createGame` | `{ choices: [4 strings] }` | Create game, return `game_id`. Caller = role A. |
| `getGame` | `{ game_id }` | Return current game state (used by polling). |
| `eliminate` | `{ game_id, role, index }` | Validate it's `role`'s turn + index still live; record elimination; advance `turn`; if 1 left → set winner + `complete`; **push to the other player**. |
| `subscribe` | `{ game_id, role, subscription }` | Store Web Push subscription for that role. |

Server-side turn/winner logic is authoritative (clients never decide the
winner). All mutations re-read the item and validate to avoid races.

## Frontend (React + Vite SPA)

Built with **React + Vite** (`npm run build` → static `dist/` for S3/CloudFront). Routes:
- `/` — **Create**: 4 text inputs → `createGame` → show shareable link +
  native **Share** button (`navigator.share`, falls back to copy) so A can
  send it via *any* messaging app. A also gets prompted to enable notifications.
- `/g/{game_id}` — **Play**: fetches state, renders the 4 choices with strike-
  through on eliminated ones, shows whose turn it is, lets the current player
  tap a choice to eliminate. On first open as B, registers push + claims role B.
- **Winner view** — when `status=complete`, both sides see the highlighted
  winning choice.

UX notes for cross-platform:
- Mobile-first responsive layout, large tap targets.
- Clear "Your turn" / "Waiting for {other}…" status banner.
- A `manifest.json` + service worker make it an installable PWA (required for
  iOS push, nice on Android/desktop too).
- The service worker handles `push` events → shows the OS notification;
  clicking it deep-links to `/g/{game_id}`.

## Repo Layout

```
choices-webapp/
  template.yaml            # SAM: DynamoDB table + Lambda + Function URL
  backend/
    handler.mjs            # single Lambda: routes createGame/getGame/eliminate/subscribe
    push.mjs               # web-push send helper (VAPID from env)
    game.mjs               # pure turn/elimination/winner logic (unit-testable)
    package.json           # dep: web-push
  frontend/
    index.html
    vite.config.js
    package.json           # deps: react, react-dom, vite
    public/
      sw.js                # service worker: push + notificationclick
      manifest.json
    src/
      main.jsx             # app entry + router
      CreateView.jsx       # 4 inputs -> createGame -> share + enable push
      PlayView.jsx         # render state, polling, eliminate, winner view
      api.js               # fetch wrappers for the 4 Lambda actions
      push.js              # PushManager subscribe + service worker registration
      styles.css
  docs/
    PLAN.md                # this plan, committed to the repo as requested
  README.md                # setup, VAPID key gen, deploy steps
```

## Implementation Steps

1. **Scaffold + docs** — create repo structure; write `docs/PLAN.md` (copy of
   this plan, as the user asked).
2. **Core game logic** (`backend/game.mjs`) — pure functions:
   `createGame(choices)`, `applyElimination(game, role, index)`,
   `nextTurn`/`computeWinner`. Unit test the B→A→B sequence + invalid moves.
   *Verify:* `node --test` passes.
3. **DynamoDB + SAM template** — define table (PK `pk`, TTL `ttl`, on-demand)
   and the Lambda + Function URL with VAPID env vars.
4. **Lambda handler** — wire the 4 actions to DynamoDB; integrate `game.mjs`;
   add Web Push send on `eliminate`.
5. **VAPID keys** — `npx web-push generate-vapid-keys`; store as SAM params /
   Lambda env (public key also exposed to frontend).
6. **Frontend create view** — 4 inputs → `createGame` → share link + enable-
   notifications prompt.
7. **Frontend play view** — render state, polling loop, role claiming,
   eliminate action, winner view.
8. **PWA + service worker** — manifest, SW registration, push subscription
   (`subscribe` action), push/notificationclick handlers; iOS install hint.
9. **Deploy** — `sam build && sam deploy --guided` for backend; `npm run build`
   then `aws s3 sync dist/` + CloudFront invalidation for frontend. Document in
   README.

## Verification (end-to-end)

- **Unit:** `game.mjs` tests cover the full B→A→B flow, out-of-turn moves,
  eliminating an already-eliminated index, and correct winner.
- **Local API:** `sam local invoke` / `sam local start-lambda` to exercise
  `createGame` → `eliminate` ×3 → `getGame` shows `complete` + winner.
- **Manual 2-device test:** open create on one device (A), open the share link
  on a second (B). Walk B→A→B; confirm each elimination triggers a push to the
  *other* device automatically and the winner shows on both.
- **iOS check:** install to Home Screen, confirm push arrives; confirm graceful
  play when push is denied (state still updates via polling).

## Decisions Made

- **Frontend:** React + Vite (confirmed).
- **Docs:** this plan copied to `docs/PLAN.md` in the repo (confirmed).

## Open Questions (minor — safe defaults assumed, will confirm during build)

1. **Custom domain?** Optional — the CloudFront URL works fine. Adds the only
   real recurring cost (domain registration). Default: no domain for v1.
2. **Choice input richness:** plain text labels only for v1 (emoji still work
   inside the text). Default assumed.
```