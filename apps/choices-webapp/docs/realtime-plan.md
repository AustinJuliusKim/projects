# Realtime plan: replacing the 3s poll (Growth Plan §10a companion)

Implementation-side design for moving game-state freshness off the adaptive
poll and onto push, evaluated honestly from hobby scale up to 1M users. This
doc is the companion to the vault's `30-projects/Choices Growth Plan.md` §10a
(locked 2026-07-23) — the vault note stays the decision of record; if the two
ever disagree, reconcile there first.

**Verdict up front:** the §10a lock (AppSync Events, polling demoted to a
30–60s keepalive, never deleted) survives a genuine stress-test against four
alternatives. It is the only option that costs ~$0 at today's scale *and*
survives 1M-MAU arithmetic. The urgency is real but not mythic: polling
breaks the budget at **~150–500 DAU**, not at 1M users.

---

## 1. What exists today

- **Adaptive poll** (`frontend/src/features/game/PlayView.jsx`): hot=3s
  (opponent's turn / no state yet), waiting=15s (opponent not joined),
  idle=30s (my turn / complete). Self-scheduling `setTimeout`, ±20% jitter,
  exponential error backoff capped at 60s, hidden tabs stop entirely and
  refetch on `visibilitychange`. Web Push is the primary channel; the poll is
  the fallback — except on Capacitor iOS (no service worker → no Web Push),
  where **the poll is the only channel**.
- **Every tick costs full price**: `GET /api?action=getState&…` → CloudFront
  (CachingDisabled) → Lambda Function URL → `doGetState` (`backend/handler.mjs`)
  → one eventually-consistent DynamoDB `GetItem`. Zero edge absorption: the
  Free pricing plan rejects custom cache policies (`template.yaml`, the
  `/api*` behavior comment, bitten 2026-07-08), and the seat token rides the
  query string (`frontend/src/lib/api.js` `getState`), so any honest cache
  key is per-seat anyway.
- **Already pre-wired for §10a**: flags `release_realtime_subscribe` (P2) and
  `release_polling_demoted` (P3) ship dark (`backend/flags.mjs`); the
  `realtime_fallback` event type is reserved with no emitter
  (`backend/events.mjs`, frozen catalog, schema `{}`); the table already has
  Streams `NEW_AND_OLD_IMAGES` and mutations already write an in-transaction
  `EVENT#` outbox item.

## 2. Why move off 3s polling — the quantified case

### Traffic model (assumptions stated so the math is checkable)

Session = 10 min open tab; hot 50% of tab time (20 req/min), idle 40%
(2/min), waiting 10% (4/min) → blended **~11 polls/min per open tab**,
~110 polls/session, 2 sessions/day → **~6,600 polls per DAU per month**.
~20 mutations per pairing-session.

Tiers: **T0** = today (~20 DAU) · **T1** = 1k DAU (~10k MAU) · **T2** =
100k DAU ("1M users" as 1M MAU at 10% DAU/MAU; peak ≈ 5–6k concurrent open
tabs) · **T3** = stress case, 1M *concurrent* tabs.

### What polling costs at each tier

Unit prices (us-west-2, 2026-07): Lambda $0.20/1M requests + $0.0000166667/GB-s
(free tier 1M req + 400k GB-s per month); DynamoDB on-demand
eventually-consistent read ≤4KB = 0.5 RRU → $0.0625/1M reads; CloudFront
flat-rate plans Free $0 / Pro $15 / Business $200 / Premium $1,000 per month
with request allowances **1M / 10M / 125M / 500M** (no overage billing, but
sustained ~3x excess triggers forced upgrade).

| | T0 (20 DAU) | T1 (1k DAU) | T2 (100k DAU) | T3 (1M concurrent) |
|---|---|---|---|---|
| Polls/month | 132k | 6.6M | 660M | ~11M/min ≈ 183k RPS |
| Lambda requests | $0 (free tier) | ~$1.12 | ~$132 | — |
| Lambda duration (20ms @256MB) | $0 | ~$0 | ~$48 | — |
| DynamoDB reads | ~$0.01 | ~$0.41 | ~$41 | — |
| CloudFront | Free plan (13% of allowance) | 6.6x over Free → **forced to Pro $15** | ≫500M → **Premium $1,000** | moot |
| **Total/month** | **~$0** | **~$17 — breaches the $10 account budget** | **~$1,200** | **~3,700 Lambda concurrency just for polls** (default limit 1,000) |

### The crossover, precisely

The Lambda free tier (1M req/mo) and the CloudFront Free plan allowance
(1M req/mo) both breach at roughly **150 DAU**. Sustained 3x+ excess
(~450–500 DAU) forces the Pro plan — $15/mo, which alone breaks the $10/mo
account budget (`ops/billing-alarms.yaml`). **Polling becomes the wrong
architecture in the 150–500 DAU band.** That is ~25x today's scale — not
urgent, but one modest growth event away, and the mitigation (edge caching)
is structurally blocked (see §3.4).

### The non-cost arguments

- **UX latency.** Median turn-notification delay = interval/2: 1.5s in hot
  mode, but **7.5s in the waiting room** — and "waiting for the opponent to
  join" is exactly the moment a new pairing lives or dies. Push delivers in
  <1s always.
- **iOS is the worst case and gains the most.** The native shell has no
  service worker, so the poll is the only update channel there today.
  WKWebView supports WebSockets fine — the platform limitation is service
  workers, not sockets.
- **Battery/radio.** A 3s cadence keeps the cellular radio cycling out of
  idle every tick; one WebSocket with ~1/min pings lets it sleep. Material
  for a mobile-first two-player game.
- **Concurrency hostage.** Every poll is a real Lambda invoke competing with
  mutations for the same concurrency pool and the same WAF budget
  (600 req/5min/IP — ~6 concurrent tabs of headroom at 3s cadence,
  `docs/feature-deploys.md`).

### The honest counter-argument

At 20 DAU polling costs a cent a month, has no connection state, no
reconnect logic, no new AWS service, no IAM delta, and behaves identically
on every platform. The adaptive tiers + visibility pause already shed ~80%
of naive-poll volume. Any realtime channel is a second correctness path that
must be shadow-verified before it can be trusted.

So the claim is **not** "polling is bad." It is: polling is correct today,
becomes budget-breaking at ~500 DAU, and is physically untenable at 1M MAU —
therefore build the push path *dark and cheap now* (which is exactly what
§10a P1–P3 stages), and keep the poll forever as the demoted backstop
(which §10a also locks).

## 3. Candidates, stress-tested

Realtime unit prices: AppSync Events **$1.00/1M operations** (publish,
delivery, connect, subscribe, and pings all count) + **$0.08/1M
connection-minutes**; API GW WebSocket $1.00/1M messages + $0.25/1M
connection-minutes (2h connection cap, 10min idle timeout); IoT Core
~$1.00/1M messages + $0.08/1M connection-minutes; Ably free tier 6M msgs/mo,
200 peak connections.

### 3.1 AppSync Events + keepalive poll — the locked §10a choice ✅

End-to-end: Events API, channel namespace `/game/{pairingId}`. Client opens
a plain WebSocket (no Amplify dependency — the Events WS protocol is simple)
and subscribes when `release_realtime_subscribe` is on. Publish happens
inline in the mutation Lambda after the version-conditioned TransactWrite
succeeds: a fire-and-forget thin ping `{type, version}` — clients then call
`getState`, keeping the `publicState` projection and token authz in one
place. Publish failure is non-fatal *because the keepalive poll exists*.
(The in-transaction `EVENT#` outbox + already-enabled DDB Streams remain
available as a decoupled at-least-once publisher later if publish logic
grows; that trades ~200ms–1s latency and a new consumer Lambda for zero
mutation-path coupling. Start inline.)

Auth: Lambda authorizer on connect/subscribe. The seat token goes in the WS
**auth payload — never the URL** (the getState precedent of tokens in query
strings, and therefore in CloudFront logs and browser history, stops here).
Authorizer = one `GetItem` + token↔pairingId↔role check, result scoped to
`/game/{pairingId}/*`, with a TTL so authorizer invokes scale with connects,
not messages. Backend publishes via IAM; no API keys.

Fallback: on subscription error/close the client emits the reserved
`realtime_fallback` `{}` event (finally giving it its emitter) and re-enters
hot polling. Under P3 the poll never dies — it collapses to a 30–60s
keepalive that doubles as the correctness backstop and keeps the `getState`
dashboard/canary meaningful. Kill switch: flip `release_realtime_subscribe`
off; the fleet reverts to today's behavior within the 60s flag cache.

Cost: T0 ≈ **$0.05/mo**. T1 ≈ **$2.60/mo** — and because polls drop to
keepalive cadence, the app stays inside the CloudFront Free plan's 1M req/mo
to roughly **2–3k DAU, a ~5x runway extension**. T2 ≈ 60M conn-min ($4.80) +
~250M ops ($252) + keepalive-poll residue (Lambda ~$12, DDB ~$4, CloudFront
Business $200) ≈ **$270–470/mo vs ~$1,200 polling** — and the keepalive
interval is the dominant residual knob (stretching 60s → 5min cuts the poll
residue 5x). T3: cost scales linearly; the pinch is the soft **2,000
connects/s** quota under a reconnect thundering herd — client-side jittered
backoff (the poller already implements this pattern) plus a quota lift.

Failure modes: reconnect herd (above); authorizer brownout (degrades to
polling, not outage); silent publish-path breakage (covered by keepalive
poll + `realtime_fallback` telemetry + a publish-error alarm).

**Verdict: winner at every tier.** ~$0 today, 3–5x cheaper than polling at
1M MAU, no Lambda-concurrency coupling, and it is already the locked
decision with flags shipped dark.

### 3.2 API Gateway WebSockets + connections table ❌

`$connect` Lambda validates the seat token and writes `CONN#<id>` keyed by
pairingId; the mutation Lambda queries connections and `PostToConnection`s
each recipient; `$disconnect` + TTL sweeps clean up. T2 ≈ **$150–200/mo** —
cheapest at scale on paper. But: self-managed fan-out and stale-connection
GC, a 2-hour connection cap and 10-min idle timeout forcing app-level pings,
API GW WS auth pushes the token toward the connect URL query string, and it
introduces the API Gateway service this app explicitly skipped for Function
URLs. Contradicts the locked §10a transport. **Reject** — viable generically,
wrong for this repo.

### 3.3 SSE via Lambda Function URL RESPONSE_STREAM ❌

Each open SSE connection **is a running Lambda invocation billed per-ms**:
at 256MB, one connection-hour = 900 GB-s ≈ $0.015. Twenty DAU × 2 sessions ×
10 min × 30 days = **180k GB-s/mo — 45% of the entire Lambda free tier at
today's scale**. T2 ≈ 900M GB-s ≈ **$15,000/mo**, with ~1,400 *average*
concurrent invocations just holding idle sockets (default limit 1,000). Add
the 15-min hard duration cap (forced reconnect churn) and CloudFront
buffering the Free plan can't tune. **Reject at every tier** — the billing
model is categorically wrong for idle connections.

### 3.4 Smarter polling + edge caching — the null hypothesis ❌

Leave the CloudFront Free plan and restore the 1s-TTL cache policy the
`template.yaml` comment anticipates. Two fatal problems. (1) Leaving the
plan means PAYG WAF: $5/ACL + $1/rule + $0.60/1M req ≈ **$10+/mo at zero
traffic** — the null hypothesis breaches the budget while idle. (2) The
cache key must include the auth, and auth is a per-seat token in the query
string, so the two players can never share a cache entry — **hit rate ≈ 0%**
unless auth first moves to headers and the response becomes role-neutral,
which is a bigger refactor than §10a P2 and puts bearer tokens into edge
cache keys. Latency is unimproved (still interval/2). The only defensible
version is "do nothing until ~500 DAU" — genuinely reasonable, except P1–P2
cost pennies and de-risk the cliff. **Reject as the growth path; keep as the
baseline comparison.**

### 3.5 IoT Core MQTT-over-WSS / managed third-party (Ably) ❌

IoT Core T2 ≈ $185/mo — cost-competitive, but auth wants Cognito identities
or IoT custom authorizers + IoT policies (poor fit for the bearer seat-token
model), plus an MQTT client library and a zero-precedent service. Ably's
free tier (6M msgs, 200 peak connections) covers hobby scale, but T2 ≈
$500+/mo, an external vendor, a token-minting endpoint, and an exit from the
all-SAM posture. **Reject both**; Ably is the fallback to remember only if
AWS realtime were ever abandoned.

### Summary at T2 (1M MAU / 100k DAU)

| Architecture | T2 $/mo | T0 $/mo | Fatal flaw |
|---|---|---|---|
| Status-quo polling | ~$1,200 | ~$0 | CloudFront allowance + concurrency; 7.5s waiting-room latency |
| **AppSync Events + keepalive (§10a)** | **~$270–470** | **~$0.05** | none structural; connect-rate quota under extreme herd |
| API GW WebSockets | ~$150–200 | ~$0 | self-managed fan-out; contradicts §10a + no-API-GW precedent |
| SSE streaming Function URL | ~$15,000 | ~$0.75 | per-ms billing of idle connections |
| Edge-cached polling | ~$700–1,000 | ~$10 idle | ~0% hit rate under per-seat tokens; idle cost > budget |
| IoT Core / Ably | ~$185 / ~$500+ | ~$0 | auth mismatch / vendor + posture exit |

## 4. Rollout (§10a phases, PR-able steps)

Each PR carries its Ops tasks per repo convention.

1. **PR 0 — IAM.** Add AppSync statements to `docs/iam-policy.json` for the
   CI deploy role (Api + ChannelNamespace CRUD, tagging); the mutation
   Lambda role gains `appsync:EventPublish`; the authorizer gets an AppSync
   invoke permission. The role has zero `appsync:*` today — this blocks
   everything else (same failure mode as the CloudFront Functions
   grant-after-the-fact, commit `713437d`). *Ops: admin applies the role
   change.*
2. **PR 1 — P1, publish side, dark.** SAM: Events API, `/game` namespace,
   Lambda authorizer wiring. Publisher as an injected-client module
   (`configureFlagsStore` house pattern, `node --test`). Mutation Lambda
   publishes the thin ping fire-and-forget after a successful TransactWrite,
   gated by a non-public ops flag. Zero subscribers; EMF
   `RealtimePublishError` (low-cardinality) + alarm → the existing
   `BillingAlertsTopic`. Cost ≈ $0.01/mo. *Ops: none beyond deploy.*
3. **PR 2 — P2, subscribe in shadow.** Client WS subscribe behind
   `release_realtime_subscribe`; polling untouched. Log event-arrival vs
   next-poll-arrival delta through existing analytics to prove correctness
   and quantify the latency win — including on Capacitor iOS. Emit
   `realtime_fallback` `{}` on subscription failure. *Ops: flip the flag for
   a canary cohort, then fleet.*
4. **PR 3 — P3, demote.** Behind `release_polling_demoted`: with a healthy
   socket, poll tiers collapse to a 30–60s keepalive; on socket loss,
   instant hot-poll + `realtime_fallback`. Dashboard and Synthetics canary
   keep exercising `getState` unchanged — no WS canary (a $10/mo canary
   cadence was already rejected as clashing with the $0 posture,
   `ops/canary.yaml`; shadow analytics from P2 are the realtime health
   signal). *Ops: flip the flag once P2 shadow data is clean.*
5. **Later knob (~10k+ DAU).** Stretch the keepalive toward 5 min — at T2
   the keepalive poll, not AppSync, dominates the residual bill.

## 5. Open items that need the vault

The ObsidianVault submodule is empty in this checkout, so these are inferred
and must be confirmed against `30-projects/Choices Growth Plan.md`:

- §10a **P1's actual text** (assumed here: publish-side dark) and any locked
  auth model for subscriptions.
- The **"L3" load-shedding ladder** implied by `ops_kill_places` — where
  realtime sits in it.
- Whether `realtime_fallback`'s empty `{}` payload is final or was reserved
  pending this design (catalog is frozen/additive-only either way).
- Verify this account's free-tier class: accounts created after July 2025
  are on a credits-based free plan, which would change the "1M req/mo
  perpetual free" Function URL assumption this doc inherits.

Follow-ups outside this doc: `README.md` still says a flat "polls every 3s"
in five places (lines 26, 40, 95, 106, 369) — update alongside PR 2/3.
