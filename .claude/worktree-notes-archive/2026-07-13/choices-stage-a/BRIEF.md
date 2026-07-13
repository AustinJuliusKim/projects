> **ADDENDUM (2026-07-12, supersedes conflicting lines below):** PR #26 (admin dashboard + EMF) is now MERGED into main. `backend/metrics.mjs` and `backend/admin.mjs` EXIST on main. The "do not import metrics.mjs" constraint and the merge-conflict warning are void. You MAY use `metrics.mjs` emitCount for a lightweight `EventOutboxWrite`/`EventLakeWrite` count where it drops in naturally (handler already wraps actions with EMF) — but keep it minimal; alarms still ride built-in Lambda IteratorAge/DLQ metrics per §5/ops. Baseline test count on main is higher than 108 now (admin tests merged); "baseline green" means whatever `node --test` reports on a clean checkout of main.
>
> **Worker rules:** worktree `/Users/aukim/personal/projects/.claude/worktrees/choices-stage-a`, branch `feature/choices-data-stage-a` (based on main). One commit per task (§7), each with its verification green. Follow global CLAUDE.md: surgical diffs, match existing zero-framework .mjs style. NEVER git push, never open PRs, never `sam deploy`. Manual-ops items (§8) are NOT yours. If blocked >30 min on one issue, note it and move to the next independent task.

# Choices — Data Architecture Stage A: Implementation Plan

Spec: `/Users/aukim/personal/ObsidianVault/30-projects/Choices Data Architecture Plan.md` (v0.3, FROZEN catalog).
Code base: `apps/choices-webapp/` — branch from **main** in a worktree (do NOT branch from `feature/admin-activity-dashboard`; `metrics.mjs`/`admin.mjs` exist only there and must not be imported).

## 0. Architecture summary

```
handler.mjs ──(transactional outbox: EVENT# items, +track action)──▶ DynamoDB
DynamoDB Streams (NEW_AND_OLD_IMAGES, filtered: EVENT# INSERT | PAIR# REMOVE)
   └─▶ streamConsumer.mjs (new Lambda, same CodeUri)
          ├─▶ s3://EventLakeBucket/raw/type=<t>/dt=YYYY-MM-DD/*.jsonl   (real pairingId, deletable)
          └─▶ s3://EventLakeBucket/anon/type=<t>/dt=YYYY-MM-DD/*.jsonl  (daily-rotating salted hash)
Glue DB (choices_events) + partition-projected tables raw_events / anon_events → Athena
compaction.mjs (weekly schedule) — tombstone-driven raw-zone rewrite
```

### Emission mechanism decision (spec says "Streams + consumer Lambda"; how events originate was ambiguous)
**Hybrid, recommended:**
1. **Transactional outbox** for server-side domain events: `handler.mjs` writes an `EVENT#<event_id>` item **in the same DynamoDB transaction** as the state change (the `savePairing`/`mutatePairing` extra-items path already exists for exactly this shape). The Streams consumer forwards these to S3 verbatim. Why not diff PAIR# old/new images: one MODIFY record can be caused by eliminate / linkClick / claimSeat / rematch / fill4-counter bumps, so reconstructing "which event" from image diffs is heuristic and loses context (actor, source, platform). The outbox makes the envelope explicit at the point where all context exists — the right posture for "the one-way door — get right first". Streams remains the sole transport (plan-compliant), and atomicity guarantees event-iff-write.
2. **Native stream interpretation only for tombstones**: `PAIR#` REMOVE records (TTL expiry today; explicit delete later) synthesize `pairing_deleted` events — these cannot be outbox writes because DynamoDB itself performs the delete. `userIdentity.principalId === "dynamodb.amazonaws.com"` ⇒ `payload.reason="ttl"`, else `"explicit"`.
3. **`track` action** for client-only catalog events (reveal_viewed, pwa_installed, …): a new handler action that validates against a strict per-type payload allowlist and writes an `EVENT#` item. One pipeline, one transport, one lag metric.

`EVENT#` items carry `ttl = now + 2 days` (lake is the durable store; table stays lean). The consumer's filter only matches `EVENT#` on INSERT, so their TTL REMOVEs are never processed.

## 1. Event envelope (the one-way door)

One JSONL line per event, identical shape in both zones:

```json
{
  "event_id": "uuid-v4",
  "ts": "2026-07-12T03:14:15.926Z",        // ISO-8601 UTC, ms precision; dt partition derived from ts
  "type": "game_finished",                 // frozen catalog enum
  "schema_v": 1,                           // per-type; bump additively only
  "pairing_ref": "a1b2c3d4e5f6" | null,    // raw zone: real pairingId; anon zone: anonRef (below); null for pairing-less events
  "actor_role": "A" | "B" | "system" | null,
  "payload": { ... }                       // per-type, validated; additive-only evolution
}
```

DynamoDB `EVENT#` item = envelope flattened + `pk: "EVENT#<event_id>"` + `ttl`. Delivery is at-least-once end to end (stream retries, S3 retries): consumers dedupe on `event_id` (document `count(distinct event_id)` in Athena examples).

## 2. Frozen catalog → emitter mapping

| type | source | actor_role | payload (raw) | anon-zone treatment |
|---|---|---|---|---|
| `game_created` | `doCreatePairing` (outbox, TransactWrite with pairing put) | A | `{game_number:1, choice_count, source:"manual"\|"fill4"}` | copy (structural only — no texts at creation) |
| `seat_claimed` | `doClaimSeat` (`savePairing` extra item) | seat | `{seat, first_claim:bool, signed_in:bool}` | copy |
| `cut_made` | `doEliminate` extraItemsFn | role | `{game_number, cut_number:1-3, index}` | copy |
| `game_finished` | `doEliminate` extraItemsFn (when complete) | role | `{game_number, winner_index, winner_label, choices:[4], duration_ms}` | labels via `normalizeLabel()`; k-floor applies at egress |
| `rematch` | `doRematch` extraItemsFn | role | `{game_number, choice_count, source}` | copy |
| `push_sent` | `pushTo` (standalone best-effort put after send) | system | `{trigger:"joined"\|"your_turn"\|"winner"\|"rematch"\|"nudge"}` | copy |
| `link_clicked` | `doLinkClick` extraItemsFn — every platform | role | `{platform}` | copy |
| `order_click` | `doLinkClick` — additionally when platform ∈ LINK_PLATFORMS | role | `{platform, place_id?}` | copy |
| `tip_given` | `doLinkClick` — platform ∈ {tip-venmo, tip-stripe} (click-through proxy; documented) | role | `{platform}` | copy |
| `reveal_card_shared` | `doLinkClick` — platform "share-reveal" | role | `{}` | copy |
| `paywall_viewed` | `doLinkClick` "premium-interest" **and** client `track` (AccountView upsell) | role/null | `{surface:"created-tease"\|"account"\|"history-lock"\|"streak-lock"}` | copy |
| `suggestion_accepted` | client `track` (typeahead selection) | role | `{layer:"pair"\|"trie"\|"places"}` — **never the text** | copy |
| `fill4_used` | `doFillMyFour` (pairing: extraItemsFn; create-screen: standalone put) | role/system | `{context:"pairing"\|"create", premium:bool, uses_left}` | copy |
| `invite_link_opened` | client `track` from JoinView (sends `code`; server resolves → pairing_ref, **drops code**) | null | `{via:"link"\|"manual"}` | copy |
| `join_abandoned` | client `track` via `sendBeacon` on pagehide from join screen w/o claim | null | `{}` | copy |
| `reveal_viewed` | client `track` (PlayView winner render, once per game) | role | `{game_number}` | copy |
| `pwa_installed` | client `track` (`appinstalled` event) | null (no pairing) | `{platform:"web"\|"ios"\|"android"}` | copy |
| `push_permission_result` | client `track` after `Notification.requestPermission` | role/null | `{result:"granted"\|"denied"\|"default"}` | copy |
| `suggestion_shown` | client `track` (once per layer per create/rematch session — volume bound) | role/null | `{layer, count:int}` — **never typed text** | copy |
| `fill4_shown` | client `track` | role/null | `{context}` | copy |
| `fill4_swapped` | client `track` | role/null | `{swap_count:int}` | copy |
| `sub_started` | `doStripeWebhook` (checkout.session.completed → status active) | system | `{plan:"monthly"\|"annual"}` — no user id | pairing_ref null; copy |
| `sub_cancelled` | `doStripeWebhook` (subscription.deleted / status canceled) | system | `{}` | copy |
| `client_error` | client `track`, global error handler | null | `{error_type:"js_error"\|"unhandled_rejection"\|"api_5xx"\|"api_network"}` — enum only, **never message text** | copy |
| `realtime_fallback` | **reserved, no emitter** (no WS yet — Growth Plan §10a not built) | — | `{}` | — |
| `pairing_deleted` | streamConsumer, PAIR# REMOVE (additive system type) | system | `{reason:"ttl"\|"explicit"}` | copy |

Enforcement of "never logged" rules lives in `events.mjs` validators: client-event payloads accept **only enumerated string values and bounded integers** — any free-form string fails validation and the event is dropped (200 `{ok:true}` returned so clients never break). Server-side text fields are limited to final choice labels of created/finished games (already 60-char capped, control-stripped by `game.mjs`).

## 3. Anonymization design

- **Master salt**: existing `AnonSalt` CFN param → `ANON_SALT` env (already plumbed on `ApiFunction`; add to consumer). No new storage.
- **Daily rotation by derivation, not storage**: `dailySalt(day) = HMAC-SHA256(ANON_SALT, "day:" + day)`; `anonRef = HMAC-SHA256(dailySalt(utcDay(ts)), pairingId).hex.slice(0, 16)`. Deterministic and stateless — no rotation job, no SSM writes, no cross-Lambda coordination; same pairing → same ref within a UTC day, unlinkable across days. Both implemented in `events.mjs` (`deriveDailySalt`, `anonRef`).
- If `ANON_SALT` is unset, the consumer **skips the anon zone entirely** (raw zone still written) — mirrors `putAnonRecord`'s existing fail-closed behavior.
- **k-anonymity floor**: an egress/aggregation-time rule (per Suggestion Engine Plan: "term must appear across ≥N distinct pairings"), not an ingestion rule — at write time k is unknowable. Stage A ships: (a) `K_ANON_FLOOR = 5` exported from `events.mjs` + `applyKFloor(rows, keyFn, refFn, k)` helper for all future batch consumers (trie builder etc.); (b) documented Athena pattern (`HAVING count(distinct pairing_ref) >= 5`) in `docs/event-lake.md`; (c) the hard ingestion guarantee that no typed text / partner-vs-partner surface ever enters any zone (validators above). Anon zone additionally never carries user ids, tokens, codes, or geo.
- **Anon zone needs no deletion path**: refs rotate daily and are one-way — nothing to compact (documented; this is why compaction is raw-zone-only, matching the spec).

## 4. Deletion / tombstone compaction

`backend/compaction.mjs`, weekly EventBridge Scheduler rate(7 days), 900s timeout, S3 CRUD on the lake bucket only.

1. List `raw/type=pairing_deleted/` (all partitions — tiny), collect `pairing_ref`s; union into `meta/tombstones.json` `{pending:[], applied:[]}` (refs not yet in `applied`).
2. If `pending` empty → write `meta/compaction-state.json` heartbeat, exit.
3. List all objects under `raw/` except `type=pairing_deleted/`; for each: GET, drop JSONL lines whose `pairing_ref` ∈ pending; if changed → PUT rewritten object (DELETE if empty). Full-lake pass is fine at current volume; bounded-work optimization is a Stage B (Parquet compaction) concern — noted in doc.
4. Move pending → applied; write state `{lastRunAt, lastRunDeletedLines, appliedCount}`.

Tombstone events themselves are retained (audit trail; a `pairing_ref` is a random 12-hex id, not PII). Pure line-filter logic (`compactLines(jsonlText, refSet)`) is unit-tested; S3 orchestration tested with `aws-sdk-client-mock`. `EventLakeBucket` gets **versioning + 30-day noncurrent-version expiry** as a compaction-bug safety net.

Note: no explicit "delete pairing" user action exists today — tombstones currently only arise from TTL REMOVEs. The pipeline is ready for a future explicit-delete action with zero changes.

## 5. Exact files

### New
| Path | Contents |
|---|---|
| `apps/choices-webapp/backend/events.mjs` | Pure module (no I/O — matches game.mjs/history.mjs convention): `EVENT_TYPES` registry (24 frozen + `pairing_deleted`) with per-type `{schema_v, validate(payload), anonymize(envelope)}`; `buildEvent(type, {pairingRef, actorRole, payload}, now)`; `eventItem(envelope)` → `{Put:{TableName, Item}}` outbox builder (pk `EVENT#<id>`, ttl +2d); `CLIENT_EVENT_TYPES` allowlist; `deriveDailySalt`, `anonRef`, `toAnonEnvelope(envelope, masterSalt)`; `K_ANON_FLOOR`, `applyKFloor`; `utcDayFromTs` |
| `apps/choices-webapp/backend/events.test.mjs` | Envelope shape, every type validates its happy payload, free-text payloads rejected for client types, anonymize strips/normalizes correctly, daily salt rotates across days & is stable within a day |
| `apps/choices-webapp/backend/streamConsumer.mjs` | `export async function handler(event)`: unmarshall records (`@aws-sdk/util-dynamodb` — new dep), EVENT# INSERT → envelope; PAIR# REMOVE → `pairing_deleted`; group by (zone, type, dt); one `PutObject` per group: `<zone>/type=<t>/dt=<d>/<epochms>-<awsRequestId>-<n>.jsonl`; anon transform per event; returns `{batchItemFailures}` on S3 errors (ReportBatchItemFailures) |
| `apps/choices-webapp/backend/streamConsumer.test.mjs` | Stream-record fixtures → asserted S3 keys/bodies via aws-sdk-client-mock; TTL-vs-explicit REMOVE; anon skip when no salt; partial-failure reporting |
| `apps/choices-webapp/backend/compaction.mjs` | As §4; export pure `compactLines` + `handler` |
| `apps/choices-webapp/backend/compaction.test.mjs` | compactLines cases; mocked S3 end-to-end incl. manifest transitions, idempotent re-run |
| `apps/choices-webapp/docs/event-lake.md` | Envelope contract + one-way-door checklist, catalog mapping table (above), zone rules, salt derivation, k-floor rule + Athena examples, deletion story, at-least-once/dedupe note, Stage B pointers |
| `ops/event-lake-alarms.yaml` | Admin-deployed (CI role has no cloudwatch perms — same pattern as ops/billing-alarms.yaml): consumer `IteratorAge > 300000ms` (the spec's ">5 min stream lag"), DLQ `ApproximateNumberOfMessagesVisible > 0` (lake write failures), compaction fn `Errors > 0`, consumer `Errors > 0`; SNS → email param |

### Modified
| Path | Change |
|---|---|
| `apps/choices-webapp/backend/handler.mjs` | Import events.mjs; `doCreatePairing` → TransactWrite [pairing put, game_created event]; `doClaimSeat` → seat_claimed extra item; `doEliminate` extraItemsFn → cut_made + game_finished (merged with existing `completionItems`); `doRematch` → extraItemsFn (rematch); `doLinkClick` → extraItemsFn (link_clicked + order_click/tip_given/reveal_card_shared/paywall_viewed mapping); `doFillMyFour` → fill4_used; `pushTo` → push_sent (fire-and-forget PutCommand, never throws into caller); `doStripeWebhook` → sub_started/sub_cancelled; new `case "track"` → `doTrack(body, user)` (type ∈ CLIENT_EVENT_TYPES, per-type validation, token auth when pairing-scoped, code→pairingId resolution for invite_link_opened/join_abandoned with the code dropped, silent drop on invalid) |
| `apps/choices-webapp/backend/handler.test.mjs` | Assert transact items include EVENT# puts per action; track auth/validation/drop cases; webhook event emission |
| `apps/choices-webapp/backend/package.json` | + `@aws-sdk/client-dynamodb` streams unmarshall dep: `@aws-sdk/util-dynamodb` |
| `apps/choices-webapp/template.yaml` | See §6 |
| `apps/choices-webapp/docs/iam-policy.json` | See §8 manual-ops item 3 (file edit is autonomous; live IAM apply is not) |
| `apps/choices-webapp/frontend/src/api.js` | `track(type, payload, opts)` — POST wrapper + `navigator.sendBeacon` variant for pagehide |
| `apps/choices-webapp/frontend/src/main.jsx` | `appinstalled` → pwa_installed; global `error`/`unhandledrejection` → client_error (enum only) |
| `apps/choices-webapp/frontend/src/JoinView.jsx` | invite_link_opened on mount-with-code; join_abandoned beacon on pagehide w/o claim |
| `apps/choices-webapp/frontend/src/PlayView.jsx` | reveal_viewed once per completed game |
| `apps/choices-webapp/frontend/src/push.js` | push_permission_result after permission prompt |
| `apps/choices-webapp/frontend/src/suggest.js` + `ChoiceInput.jsx` | suggestion_shown (once/layer/session), suggestion_accepted (layer only) |
| `apps/choices-webapp/frontend/src/FillMyFour.jsx` | fill4_shown, fill4_swapped |
| `apps/choices-webapp/frontend/src/AccountView.jsx` | paywall_viewed (account/history-lock/streak-lock surfaces) |

**Untouched on purpose**: `putAnonRecord` + `SuggestDataBucket` `entries/` feed keeps running (Suggestion Phase 2 is spec'd against it); deprecation is a follow-up once Phase 2 reads the lake (data plan: "Phase 0 becomes a lake consumer"). `game.mjs`, `history.mjs`, `stats.mjs` stay pure and unmodified.

## 6. template.yaml resources (logical IDs)

- `GamesTable`: add `StreamSpecification: {StreamViewType: NEW_AND_OLD_IMAGES}` (in-place update, no replacement, no downtime).
- `EventLakeBucket` (AWS::S3::Bucket): PublicAccessBlock all-true, `VersioningConfiguration: Enabled`, lifecycle `NoncurrentVersionExpirationInDays: 30`. Never reuse SiteBucket/SuggestDataBucket.
- `EventConsumerDLQ` (AWS::SQS::Queue), `MessageRetentionPeriod: 1209600`.
- `EventStreamConsumerFunction` (AWS::Serverless::Function): `CodeUri: backend/`, `Handler: streamConsumer.handler` (shares deps/module code with ApiFunction — simplest given the existing single-dir layout), Timeout 60, env `EVENT_LAKE_BUCKET`, `ANON_SALT`; Policies: `S3WritePolicy` on EventLakeBucket; Events:
  ```yaml
  Stream:
    Type: DynamoDB
    Properties:
      Stream: !GetAtt GamesTable.StreamArn
      StartingPosition: TRIM_HORIZON
      BatchSize: 100
      MaximumBatchingWindowInSeconds: 10
      BisectBatchOnFunctionError: true
      MaximumRetryAttempts: 8
      FunctionResponseTypes: [ReportBatchItemFailures]
      DestinationConfig: { OnFailure: { Destination: !GetAtt EventConsumerDLQ.Arn } }
      FilterCriteria:
        Filters:
          - Pattern: '{"eventName":["INSERT"],"dynamodb":{"Keys":{"pk":{"S":[{"prefix":"EVENT#"}]}}}}'
          - Pattern: '{"eventName":["REMOVE"],"dynamodb":{"Keys":{"pk":{"S":[{"prefix":"PAIR#"}]}}}}'
  ```
- `CompactionFunction` (AWS::Serverless::Function): `Handler: compaction.handler`, Timeout 900, MemorySize 512, env `EVENT_LAKE_BUCKET`; Policies `S3CrudPolicy` on EventLakeBucket; Events: `ScheduleV2` `rate(7 days)`.
- `GlueEventsDatabase` (AWS::Glue::Database): name via new param `GlueDatabaseName` (default `choices_events`; preview override `choices_events_preview` — Glue names must be lowercase, stack name unusable).
- `GlueRawEventsTable` / `GlueAnonEventsTable` (AWS::Glue::Table): columns `event_id string, ts string, schema_v int, pairing_ref string, actor_role string, payload map<string,string>`; partition keys `type string, dt string`; SerDe `org.openx.data.jsonserde.JsonSerDe`; TableInput Parameters for **partition projection** (no crawler, no MSCK): `projection.enabled=true`, `projection.type.type=enum`, `projection.type.values=<all 25 types comma-joined>` (frozen catalog makes enum projection safe; adding a type = one template line, additive), `projection.dt.type=date`, `projection.dt.format=yyyy-MM-dd`, `projection.dt.range=2026-07-01,NOW`, `storage.location.template=s3://${EventLakeBucket}/raw/type=${type}/dt=${dt}/` (resp. `anon/`). `payload` as `map<string,string>` (OpenX coerces scalars); per-type typed views are Stage B.
- `AthenaResultsBucket` (private, lifecycle expire 30d) + `EventsWorkGroup` (AWS::Athena::WorkGroup, ResultConfiguration → results bucket, EnforceWorkGroupConfiguration true).
- `ApiFunction`: no new env needed (outbox writes use existing TABLE_NAME + DynamoDBCrudPolicy).
- Outputs: `EventLakeBucketName`, `GlueDatabaseName`, `AthenaWorkGroup`.

## 7. Ordered task list (autonomous subagent, git worktree from main)

Each task = commit + verification. Baseline first.

| # | Task | Verification (local, no deploy) |
|---|---|---|
| 0 | Worktree from main; `cd apps/choices-webapp/backend && npm ci` | `node --test` green (baseline ~108 tests); `sam validate --lint` green |
| 1 | `events.mjs` + `events.test.mjs` (registry, envelope, validators, anonymizers, salt derivation, k-floor helper, eventItem) | `node --test`; explicit tests: typed-text payload rejected for every CLIENT_EVENT type; salt rotates across UTC days |
| 2 | Handler outbox: game_created, seat_claimed, cut_made, game_finished, rematch (+ handler.test.mjs) | `node --test`; assert TransactWrite item lists contain the expected EVENT# puts (aws-sdk-client-mock captures) |
| 3 | Handler: link_clicked/order_click/tip_given/reveal_card_shared/paywall_viewed mapping, fill4_used, push_sent, sub_started/sub_cancelled | `node --test` |
| 4 | `track` action + doTrack (auth, code resolution, silent drop) | `node --test`; cases: bad type dropped, missing token on pairing-scoped type dropped, code never persisted in event |
| 5 | `streamConsumer.mjs` + tests; add `@aws-sdk/util-dynamodb` | `node --test` (mocked S3: key layout, JSONL bodies, anon transform, no-salt skip, tombstone synthesis, batchItemFailures) |
| 6 | `compaction.mjs` + tests | `node --test` (line filtering, manifest lifecycle, idempotent re-run, empty-object delete) |
| 7 | `template.yaml` (§6) + `GlueDatabaseName` preview override in `samconfig.toml` | `sam validate --lint`; `sam build` succeeds |
| 8 | Frontend: `api.js` track + beacons in main.jsx / JoinView / PlayView / push.js / suggest.js / ChoiceInput / FillMyFour / AccountView | `cd frontend && npm ci && npm run build` green; grep-audit: no beacon sends free text, code only sent to `track` for invite_link_opened/join_abandoned |
| 9 | `docs/event-lake.md`; update `docs/iam-policy.json` (§8.3); `ops/event-lake-alarms.yaml` | `python3 -c "import yaml,sys; yaml.safe_load(open('ops/event-lake-alarms.yaml'))"` (billing-alarms.yaml precedent — plain CFN, sam validate not applicable); doc reviewed against the three "never logged" rules |
| 10 | Final sweep: full `node --test`, frontend build, `sam validate --lint`, privacy checklist self-review (no keystrokes/typed text, no user ids/codes/tokens/geo in any envelope, anon zone free of raw pairing ids), then PR with catalog-mapping table in the description | all of the above green; `git diff main --stat` matches §5 file list |

Sizing: matches the plan's "~2–3d Sonnet" (tasks 1–7 core pipeline, 8 is trimmable to a follow-up PR if needed — the pipeline is complete without client beacons; server-side events cover core + monetization-click funnel day one).

## 8. Manual ops (cannot be done autonomously)

1. **Merge sequencing** vs `feature/admin-activity-dashboard` (1 commit ahead of main, touches handler.mjs switch + doEliminate): whichever merges second resolves a small mechanical conflict. Decide order before merging.
2. **Live IAM deploy-policy update** (admin creds; docs/iam-policy.json edit lands in the PR, applying it doesn't): add `dynamodb:*Stream*` (DescribeStream/GetRecords/GetShardIterator/ListStreams on `table/choices-games*/stream/*`), `lambda:CreateEventSourceMapping/GetEventSourceMapping/UpdateEventSourceMapping/DeleteEventSourceMapping` (+ `ListEventSourceMappings`), `sqs:CreateQueue/DeleteQueue/GetQueueAttributes/SetQueueAttributes/TagQueue`, `glue:CreateDatabase/DeleteDatabase/GetDatabase/CreateTable/UpdateTable/DeleteTable/GetTable`, `scheduler:CreateSchedule/GetSchedule/UpdateSchedule/DeleteSchedule` + `iam:PassRole` for the scheduler role, `athena:CreateWorkGroup/GetWorkGroup/UpdateWorkGroup/DeleteWorkGroup/TagResource`, S3 bucket perms for `choiceswebapp*eventlake*` and `choiceswebapp*athenaresults*` ARNs. Also fix existing drift: DynamoDBManage is scoped to `table/choices-games` only — preview table `choices-games-preview` needs covering (`table/choices-games*`).
3. **Preview deploy + smoke** (`sam deploy --config-env preview`): play a full game on preview, then check `aws s3 ls` shows raw+anon objects under the right partitions; confirm DLQ empty; confirm PAIR# TTL REMOVE eventually produces a tombstone (or force one by deleting a test item).
4. **Verify `AnonSalt` is set** on both stacks (NoEcho, stored-value reuse; suggestion-plan ops list flagged it as possibly pending). If unset: `openssl rand -hex 32`, pass via `--parameter-overrides` once per stack. Without it the anon zone is silently disabled.
5. **Athena live check**: run a projection-partitioned query in the new workgroup (`SELECT type, count(distinct event_id) FROM choices_events.raw_events WHERE dt >= date_format(current_date - interval '7' day, '%Y-%m-%d') GROUP BY type`).
6. **Deploy `ops/event-lake-alarms.yaml`** with admin creds (same flow as billing-alarms), confirm SNS email subscriptions.
7. **Prod deploy**, then monitor IteratorAge/DLQ for a day.
8. **Backfill decision**: the old `entries/` feed *could* be backfilled into anon `game_finished` events, but its pairHash used a static salt — refs are incompatible with daily-rotating anonRefs and would poison distinct-pair counts. Recommendation: **don't backfill**; if historical queries matter, add a separate Glue table over `s3://SuggestDataBucket/entries/` instead (10-minute console/IaC task).
9. **Later**: retire `putAnonRecord` once Suggestion Phase 2 reads the lake (tracked in vault, not this PR).

## 9. Conflicts: plan doc vs current code

1. **`metrics.mjs`/EMF exists only on the unmerged branch, not main.** Stage A code must not import it; pipeline metrics use built-in Lambda/SQS metrics + alarms (`IteratorAge` *is* the spec's stream-lag metric). If the admin branch merges first, a follow-up can add `emitCount("EventLakeWrite")` trivially.
2. **Existing anon feed violates the new rotation rule**: `putAnonRecord` uses a *static* salt (`ANON_SALT` directly) — Stage A's daily-rotating hash supersedes it for the lake; old feed left running only as Phase-2's current input (acknowledged tech debt, §8.9).
3. **Doc's "Streams interpret existing writes" vs the catalog**: 14 of 24 frozen types have no DynamoDB write to interpret (client-side and webhook events). Resolved via outbox + `track` (§0), with Streams still the sole transport.
4. **`link_clicked` vs `order_click` overlap** in the frozen catalog: interpreted as generic-outbound-click vs order-platform-specific; both emitted for order platforms (catalog is frozen with both; double emission costs nothing and keeps funnel queries direct). Flag in PR for Austin's confirmation.
5. **`realtime_fallback` has no possible emitter** (WebSockets not built — Growth §10a pending): type reserved in registry + Glue enum, no code path.
6. **No explicit pairing-delete action exists**; tombstones today arise only from TTL. The compaction design already covers a future explicit delete unchanged.
7. **CI deploy role lacks every new service** (streams, ESM, glue, scheduler, sqs, athena, new buckets) and has pre-existing drift (preview table not covered) — §8.2.
8. **`join_abandoned` is necessarily heuristic** (pagehide beacon, at-most-once-ish) — documented as approximate in event-lake.md.
