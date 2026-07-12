# Event lake (Data Architecture, Stage A)

Spec: ObsidianVault `30-projects/Choices Data Architecture Plan.md` (v0.3,
FROZEN catalog). Code: `backend/events.mjs` (catalog + envelope),
`backend/handler.mjs` (outbox + `track`), `backend/streamConsumer.mjs`
(lake writer), `backend/compaction.mjs` (deletion), `template.yaml`
(stream, bucket, Glue/Athena), `ops/event-lake-alarms.yaml` (alarms).

```
handler.mjs ──(transactional outbox: EVENT# items, + track action)──▶ DynamoDB
DynamoDB Streams (NEW_AND_OLD_IMAGES; filtered: EVENT# INSERT | PAIR# REMOVE)
   └─▶ streamConsumer.mjs
          ├─▶ s3://EventLakeBucket/raw/type=<t>/dt=YYYY-MM-DD/*.jsonl   (real pairingId, deletable)
          └─▶ s3://EventLakeBucket/anon/type=<t>/dt=YYYY-MM-DD/*.jsonl  (daily-rotating salted hash)
Glue db (GlueDatabaseName param) raw_events / anon_events (partition projection) → Athena (EventsWorkGroup)
compaction.mjs (weekly) — tombstone-driven raw-zone rewrite
```

## Envelope — the one-way door

One JSON object per line, identical shape in both zones:

```json
{
  "event_id": "uuid-v4",
  "ts": "2026-07-12T03:14:15.926Z",
  "type": "game_finished",
  "schema_v": 1,
  "pairing_ref": "a1b2c3d4e5f6",
  "actor_role": "B",
  "payload": { "game_number": 2, "winner_index": 3, "...": "..." }
}
```

- `ts` is ISO-8601 UTC with ms; the `dt` partition is derived from it.
- `pairing_ref`: raw zone = real pairingId; anon zone = daily anonRef
  (below); `null` for pairing-less events (pwa_installed, client_error,
  sub_*).
- `actor_role`: `"A" | "B" | "system" | null`.
- `schema_v` is per-type and bumps **additively only**.

**One-way-door checklist for any envelope/catalog change:**
1. Additive only — never remove, rename, or repurpose a field or type.
2. New payload fields must pass the same gate: enumerated strings or
   bounded ints for anything a client can send; server-side text is
   limited to final choice labels (60-char capped, control-stripped by
   `game.mjs`) and Places `place_id`.
3. New type ⇒ registry entry in `events.mjs` **and** one value appended to
   `projection.type.values` on both Glue tables in `template.yaml`.
4. Never in any envelope: keystrokes/typed text, user ids, join codes,
   tokens, geo. Never in the anon zone: raw pairing ids.
5. Bump `schema_v` for the type when adding payload fields; old rows keep
   validating (readers must treat absent fields as absent, not defaulted).

## Catalog v1 (FROZEN 2026-07-11) → emitters

| type | emitter | actor_role | payload |
|---|---|---|---|
| `game_created` | doCreatePairing (outbox tx) | A | `{game_number:1, choice_count, source:"manual"\|"fill4"}` |
| `seat_claimed` | doClaimSeat (outbox tx) | seat | `{seat, first_claim, signed_in}` |
| `cut_made` | doEliminate (outbox tx, every cut) | role | `{game_number, cut_number:1-3, index:0-3}` |
| `game_finished` | doEliminate completion (outbox tx) | final cutter | `{game_number, winner_index, winner_label, choices[4], duration_ms}` |
| `rematch` | doRematch (outbox tx) | role | `{game_number, choice_count, source}` |
| `push_sent` | pushTo (standalone, only accepted sends) | system | `{trigger:"joined"\|"your_turn"\|"winner"\|"rematch"\|"nudge"}` |
| `link_clicked` | doLinkClick (outbox tx, every platform) | role | `{platform}` |
| `order_click` | doLinkClick, platform ∈ LINK_PLATFORMS (emitted **in addition to** link_clicked — frozen catalog carries both; dedupe is a query concern) | role | `{platform, place_id?}` |
| `tip_given` | doLinkClick, tip-venmo/tip-stripe (click-through proxy, not payment confirmation) | role | `{platform}` |
| `reveal_card_shared` | doLinkClick, share-reveal | role | `{}` |
| `paywall_viewed` | doLinkClick premium-interest (created-tease) + client track (account surfaces) | role/null | `{surface:"created-tease"\|"account"\|"history-lock"\|"streak-lock"}` |
| `suggestion_accepted` | client track (pairing-scoped) | role | `{layer:"pair"\|"trie"\|"places"}` — never the text |
| `fill4_used` | doFillMyFour (pairing: outbox tx; create screen: standalone, actor system) | role/system | `{context, premium, uses_left}` |
| `invite_link_opened` | client track (code → pairing_ref, code dropped) | null | `{via:"link"\|"manual"}` |
| `join_abandoned` | client track, sendBeacon on pagehide w/o claim (heuristic, at-most-once-ish) | null | `{}` |
| `reveal_viewed` | client track (winner face render, once per game per mount) | role | `{game_number}` |
| `pwa_installed` | client track (`appinstalled`) | null | `{platform:"web"\|"ios"\|"android"}` |
| `push_permission_result` | client track (only when a real prompt was shown) | role/null | `{result:"granted"\|"denied"\|"default"}` |
| `suggestion_shown` | client track (once per layer per app session) | role/null | `{layer, count}` |
| `fill4_shown` | client track (affordance mount) | role/null | `{context}` |
| `fill4_swapped` | client track (re-fill count within one form) | role/null | `{swap_count}` |
| `sub_started` | doStripeWebhook, checkout completed (plan via session metadata; pre-metadata sessions skip) | system | `{plan:"monthly"\|"annual"}` |
| `sub_cancelled` | doStripeWebhook, any canceled status | system | `{}` |
| `client_error` | client track: global handlers + api layer | null | `{error_type:"js_error"\|"unhandled_rejection"\|"api_5xx"\|"api_network"}` — enum only |
| `realtime_fallback` | **reserved, no emitter** (no WS yet — Growth Plan §10a) | — | `{}` |
| `pairing_deleted` | streamConsumer, PAIR# REMOVE (additive system type) | system | `{reason:"ttl"\|"explicit"}` |

Client events go through the `track` action: only `CLIENT_EVENT_TYPES`,
strict per-type validation (free-form strings never validate), seat-token
auth for pairing-scoped types, silent 200 drops. Join codes are resolved
server-side to a `pairing_ref` and never persisted.

## Zones

- **raw/** — real `pairing_ref`. Powers pair-scoped features and joins.
  Deletable: see deletion story. Access = ops only.
- **anon/** — `pairing_ref` replaced by a **daily-rotating** salted hash;
  `game_finished` labels normalized (`normalizeLabel`). Everything else in
  the catalog is structural and copies as-is. The anon zone never carries
  user ids, codes, tokens, or geo — and needs **no deletion path**: refs
  are one-way and unlinkable across days, so compaction is raw-only.

### Salt derivation (stateless rotation)

```
dailySalt(day) = HMAC-SHA256(ANON_SALT, "day:" + day)      // day = YYYY-MM-DD of event ts
anonRef        = HMAC-SHA256(dailySalt, pairingId).hex[:16]
```

No rotation job, no stored per-day salts: the same inputs give the same
ref anywhere, same pairing links **within** a UTC day, never across days.
`ANON_SALT` is the existing CFN param (NoEcho); if unset the consumer
skips the anon zone entirely (fail closed) while raw keeps flowing.
Note: the legacy `SuggestDataBucket entries/` feed uses a *static* salt —
its pairHashes are incompatible with anonRefs by design (do not join, do
not backfill; see the data plan's ops notes).

## k-anonymity floor (egress rule)

k is unknowable at write time, so the floor applies at
aggregation/egress, in every batch consumer: a term may only surface if it
appears across **≥ 5 distinct pairings** (`K_ANON_FLOOR` and
`applyKFloor(rows, keyFn, refFn)` in `events.mjs`). Athena shape:

```sql
SELECT payload['winner_label'] AS label,
       count(distinct pairing_ref)  AS pairs
FROM anon_events
WHERE type = 'game_finished' AND dt >= '2026-07-01'
GROUP BY 1
HAVING count(distinct pairing_ref) >= 5
ORDER BY pairs DESC;
```

Caution: refs rotate daily, so `count(distinct pairing_ref)` over a
multi-day window **overcounts** pairs (the same pair gets a new ref each
day), which *weakens* the floor — one pair active 5 days would pass a
naive 5-distinct check. Enforce the floor within a single `dt` (as the
trie builder will), or require `count(distinct (dt, pairing_ref)) >= 5`
only when day-level activity is genuinely the unit you mean.

## Querying (Athena)

Workgroup: `AthenaWorkGroup` output; database: `GlueDatabaseName` output
(`choices_events` prod, `choices_events_preview` preview). Tables
`raw_events` / `anon_events` use partition projection — always constrain
`type` and `dt`. Delivery is **at-least-once** end to end (stream retries,
partial-batch retries, cross-zone retry duplication), so dedupe on
`event_id`:

```sql
SELECT type, count(distinct event_id) AS events
FROM raw_events
WHERE dt >= date_format(current_date - interval '7' day, '%Y-%m-%d')
GROUP BY type;
```

## Deletion story

`PAIR#` REMOVEs (TTL today — pairings expire after 30 idle days; explicit
delete later, zero code changes) synthesize `pairing_deleted` tombstones.
Weekly `compaction.mjs`:

1. Union tombstoned refs into `meta/tombstones.json` `{pending, applied}`.
2. Rewrite every raw object minus pending refs (delete emptied objects);
   the `type=pairing_deleted/` partition is retained as the audit trail (a
   pairing_ref is a random 12-hex id, not PII).
3. Move pending → applied; write `meta/compaction-state.json`
   `{lastRunAt, lastRunDeletedLines, appliedCount}`.

Idempotent re-runs; a crash mid-run keeps refs pending. Known edges:

- **Late writers**: a raw event for a ref written *after* its ref moved to
  `applied` is never cleaned by later runs. Practically unreachable — the
  tombstone itself comes from the pairing's TTL expiry after 30 idle days,
  and every emitter requires the live pairing — but if an explicit-delete
  action ever races the outbox, reset the ref from `applied` back to
  `pending` in `meta/tombstones.json` and re-run.
- **Delete markers**: the bucket is versioned (30-day noncurrent expiry as
  the compaction-bug safety net), and delete markers themselves never
  expire. Harmless at this volume; a future lifecycle rule with
  `ExpiredObjectDeleteMarker: true` tidies them.
- Full-lake pass per run is fine at current volume; bounded-work
  compaction is a Stage B (Parquet) concern.

## Pipeline health

`ops/event-lake-alarms.yaml` (admin-deployed, like billing-alarms):
consumer `IteratorAge > 5 min` (the spec's stream-lag alarm), DLQ depth
`> 0` (lake write failures past 8 bisected retries), consumer/compaction
`Errors > 0`. The consumer also emits an EMF `EventLakeWrite` count
(ChoicesApp namespace) for dashboard use — alarms deliberately ride the
built-in metrics only.

## Stage B pointers (build on triggers, not now)

Triggers: ~10k games/mo or first real dashboard need. Then: JSONL →
Parquet compaction (Athena cost ~10×↓), typed per-type views over
`payload`, scheduled Athena → CloudWatch business metrics, and the
suggestion trie / taste vectors / funnel reports all reading the lake
(never DDB). The `entries/` Phase-0 feed retires once Suggestion Phase 2
reads the lake.
