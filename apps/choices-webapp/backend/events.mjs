// Event lake envelope + frozen catalog (Data Architecture Plan, Stage A).
// Pure module (no I/O — mirrors game.mjs/history.mjs) so validators and
// anonymizers are unit-testable and shared by handler.mjs (outbox writes)
// and streamConsumer.mjs (lake writes).
//
// The envelope is the one-way door:
//   { event_id, ts, type, schema_v, pairing_ref, actor_role, payload }
// Additive-only evolution: new payload fields never repurpose old ones;
// new types are additive registry entries. Privacy invariants enforced
// here: payload validators accept only enumerated strings and bounded
// integers (server-side exceptions: final choice labels — already 60-char
// capped and control-stripped by game.mjs — and Places place_id). No user
// ids, codes, tokens, or geo ever ride an envelope.
import { createHmac, randomUUID } from "node:crypto";
import { LINK_PLATFORMS, SUPPORT_PLATFORMS } from "./game.mjs";
import { normalizeLabel } from "./history.mjs";

// EVENT# outbox items expire after 2 days — the lake is the durable store;
// the table only carries events until the stream consumer forwards them.
const EVENT_TTL_DAYS = 2;

// --- Payload validator combinators (strict: unknown keys reject) ---

const isPlainObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = (...vals) => (v) => vals.includes(v);
const intIn = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const bool = (v) => v === true || v === false;
// Server-produced choice label (game.mjs caps at 60 and strips controls).
const label = (v) => typeof v === "string" && v.length > 0 && v.length <= 60;
// Game choice lists: 3–8 labels (variable choice count; was exactly 4 in
// schema_v 1 rows).
const gameLabels = (v) =>
  Array.isArray(v) && v.length >= 3 && v.length <= 8 && v.every(label);
// Google Places id (same 300-char bound as doPlaceDetails).
const placeId = (v) => typeof v === "string" && v.length > 0 && v.length <= 300;
// Flag names: lifecycle-prefixed snake_case identifiers (§10c).
const flagName = (v) => typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v);

function shape(required, optional = {}) {
  return (payload) => {
    if (!isPlainObject(payload)) return false;
    for (const k of Object.keys(payload)) {
      if (!(k in required) && !(k in optional)) return false;
    }
    for (const [k, check] of Object.entries(required)) {
      if (!(k in payload) || !check(payload[k])) return false;
    }
    for (const [k, check] of Object.entries(optional)) {
      if (k in payload && !check(payload[k])) return false;
    }
    return true;
  };
}

const gameNumber = intIn(1, 1_000_000);
const source = oneOf("manual", "fill4");
const layer = oneOf("pair", "trie", "places");
const fillContext = oneOf("pairing", "create");

// game_finished is the only type whose payload carries text; the anon zone
// gets normalized labels (the same canonical form the suggestion feed uses).
function anonymizeGameFinished(payload) {
  return {
    ...payload,
    winner_label: normalizeLabel(payload.winner_label),
    choices: payload.choices.map(normalizeLabel),
  };
}

// --- Frozen catalog v1 (2026-07-11) + pairing_deleted (additive system
// type synthesized by the stream consumer from PAIR# REMOVE records).
//
// Per type: schema_v (bump additively only), validate(payload),
// anonymize(payload) (default: copy — payloads are structural), and for
// client-trackable types a `client` scope consumed by the track action:
//   "pairing"  — requires pairingId + seat token; actor_role = role
//   "code"     — join flow: client sends the join code, the server resolves
//                it to a pairing_ref and DROPS the code; actor_role = null
//   "optional" — pairing-scoped when pairingId is sent (token required),
//                otherwise pairing_ref null
//   "none"     — never pairing-scoped
export const EVENT_TYPES = Object.freeze({
  // Core
  game_created: {
    schema_v: 1,
    validate: shape({ game_number: intIn(1, 1), choice_count: intIn(1, 16), source }),
  },
  seat_claimed: {
    schema_v: 1,
    validate: shape({ seat: oneOf("A", "B"), first_claim: bool, signed_in: bool }),
  },
  // schema_v 2 (2026-07-22): bounds widened for variable choice count 3–8
  // (cut_number 1–7, index/winner_index 0–7, choices 3–8 labels). Fields
  // unchanged — additive evolution per the catalog rules.
  cut_made: {
    schema_v: 2,
    validate: shape({ game_number: gameNumber, cut_number: intIn(1, 7), index: intIn(0, 7) }),
  },
  game_finished: {
    schema_v: 2,
    validate: shape({
      game_number: gameNumber,
      winner_index: intIn(0, 7),
      winner_label: label,
      choices: gameLabels,
      duration_ms: intIn(0, 100_000_000_000),
    }),
    anonymize: anonymizeGameFinished,
  },
  rematch: {
    schema_v: 1,
    validate: shape({ game_number: gameNumber, choice_count: intIn(1, 16), source }),
  },
  push_sent: {
    schema_v: 1,
    validate: shape({ trigger: oneOf("joined", "your_turn", "winner", "rematch", "nudge") }),
  },
  link_clicked: {
    schema_v: 1,
    validate: shape({ platform: oneOf(...LINK_PLATFORMS, ...SUPPORT_PLATFORMS) }),
  },
  suggestion_accepted: {
    schema_v: 1,
    validate: shape({ layer }),
    client: "pairing",
  },
  fill4_used: {
    schema_v: 1,
    validate: shape({
      context: fillContext,
      premium: bool,
      uses_left: (v) => v === null || intIn(0, 99)(v),
    }),
  },
  // Bundle A — funnel/viral
  invite_link_opened: {
    schema_v: 1,
    validate: shape({ via: oneOf("link", "manual") }),
    client: "code",
  },
  join_abandoned: {
    schema_v: 1,
    validate: shape({}),
    client: "code",
  },
  reveal_viewed: {
    schema_v: 1,
    validate: shape({ game_number: gameNumber }),
    client: "pairing",
  },
  reveal_card_shared: {
    schema_v: 1,
    validate: shape({}),
  },
  pwa_installed: {
    schema_v: 1,
    validate: shape({ platform: oneOf("web", "ios", "android") }),
    client: "none",
  },
  push_permission_result: {
    schema_v: 1,
    validate: shape({ result: oneOf("granted", "denied", "default") }),
    client: "optional",
  },
  // Bundle B — suggestion/AI
  suggestion_shown: {
    schema_v: 1,
    validate: shape({ layer, count: intIn(0, 50) }),
    client: "optional",
  },
  fill4_shown: {
    schema_v: 1,
    validate: shape({ context: fillContext }),
    client: "optional",
  },
  fill4_swapped: {
    schema_v: 1,
    validate: shape({ swap_count: intIn(0, 100) }),
    client: "optional",
  },
  // Bundle C — monetization
  order_click: {
    schema_v: 1,
    validate: shape({ platform: oneOf(...LINK_PLATFORMS) }, { place_id: placeId }),
  },
  paywall_viewed: {
    schema_v: 1,
    validate: shape({
      surface: oneOf("created-tease", "account", "history-lock", "streak-lock"),
    }),
    client: "optional",
  },
  sub_started: {
    schema_v: 1,
    validate: shape({ plan: oneOf("monthly", "annual") }),
  },
  sub_cancelled: {
    schema_v: 1,
    validate: shape({}),
  },
  tip_given: {
    schema_v: 1,
    validate: shape({ platform: oneOf("tip-venmo", "tip-stripe") }),
  },
  // Bundle D — ops
  client_error: {
    schema_v: 1,
    validate: shape({
      error_type: oneOf("js_error", "unhandled_rejection", "api_5xx", "api_network"),
    }),
    client: "none",
  },
  realtime_fallback: {
    // Reserved: no emitter until WebSockets exist (Growth Plan §10a).
    schema_v: 1,
    validate: shape({}),
  },
  // Additive system type: synthesized by streamConsumer from PAIR# REMOVE.
  pairing_deleted: {
    schema_v: 1,
    validate: shape({ reason: oneOf("ttl", "explicit") }),
  },
  // Bundle E — flags (added 2026-07-23, additive; Growth Plan §10c). Admin
  // actor only, never PII: updated_by is a role marker, not a Cognito sub.
  flag_changed: {
    schema_v: 1,
    validate: shape({
      flag: flagName,
      enabled_old: bool,
      enabled_new: bool,
      default_old: bool,
      default_new: bool,
      updated_by: oneOf("admin"),
    }),
  },
});

// Types the client may send through the `track` action, mapped to their
// pairing scope (see the legend above). Everything else is server-emitted
// only — a track call naming a non-client type is silently dropped.
export const CLIENT_EVENT_TYPES = Object.freeze(
  Object.fromEntries(
    Object.entries(EVENT_TYPES)
      .filter(([, def]) => def.client)
      .map(([type, def]) => [type, def.client])
  )
);

const ACTOR_ROLES = ["A", "B", "system", null];

// Build a validated envelope. Throws on unknown type / bad payload / bad
// actor role — server emitters construct payloads themselves, so a throw
// here is a programming error, never user input (doTrack validates before
// calling this and drops instead).
export function buildEvent(type, { pairingRef = null, actorRole = null, payload = {} } = {}, now = Date.now()) {
  const def = EVENT_TYPES[type];
  if (!def) throw new Error(`Unknown event type: ${type}`);
  if (!ACTOR_ROLES.includes(actorRole)) {
    throw new Error(`Bad actor_role for ${type}: ${actorRole}`);
  }
  if (!def.validate(payload)) {
    throw new Error(`Invalid payload for ${type}`);
  }
  return {
    event_id: randomUUID(),
    ts: new Date(now).toISOString(),
    type,
    schema_v: def.schema_v,
    pairing_ref: pairingRef,
    actor_role: actorRole,
    payload,
  };
}

// Transactional-outbox Put for an envelope: the EVENT# item is the envelope
// flattened plus pk and a short ttl. Shaped for savePairing's extraItems /
// TransactWrite lists.
export function eventItem(envelope, tableName = process.env.TABLE_NAME) {
  return {
    Put: {
      TableName: tableName,
      Item: {
        pk: `EVENT#${envelope.event_id}`,
        ...envelope,
        ttl: Math.floor(Date.parse(envelope.ts) / 1000) + EVENT_TTL_DAYS * 24 * 3600,
      },
    },
  };
}

// --- Anonymization (anon zone) ---

// UTC day (YYYY-MM-DD) an ISO timestamp falls on; the dt= partition key.
export function utcDayFromTs(ts) {
  return String(ts).slice(0, 10);
}

// Daily salt by derivation, not storage: HMAC(master, "day:"+day). No
// rotation job — the same inputs give the same salt anywhere, and salts for
// different days are unlinkable without the master.
export function deriveDailySalt(masterSalt, day) {
  return createHmac("sha256", masterSalt).update(`day:${day}`).digest();
}

// Anon-zone pairing ref: HMAC(dailySalt(day-of-event), pairingId), 16 hex
// chars. Same pairing → same ref within a UTC day; unlinkable across days.
export function anonRef(masterSalt, pairingId, ts) {
  return createHmac("sha256", deriveDailySalt(masterSalt, utcDayFromTs(ts)))
    .update(pairingId)
    .digest("hex")
    .slice(0, 16);
}

// The anon-zone copy of an envelope: pairing_ref replaced by the daily-
// rotating hash (never the raw id), payload passed through the type's
// anonymizer (labels normalized for game_finished; everything else is
// structural and copies as-is).
export function toAnonEnvelope(envelope, masterSalt) {
  const def = EVENT_TYPES[envelope.type];
  return {
    ...envelope,
    pairing_ref:
      envelope.pairing_ref == null
        ? null
        : anonRef(masterSalt, envelope.pairing_ref, envelope.ts),
    payload: def?.anonymize ? def.anonymize(envelope.payload) : envelope.payload,
  };
}

// --- k-anonymity floor (egress-time rule for batch consumers) ---

// "A term must appear across ≥ K distinct pairings before it may surface"
// (Suggestion Engine Plan). Applied at aggregation/egress — at write time k
// is unknowable. Athena equivalent: HAVING count(distinct pairing_ref) >= 5.
export const K_ANON_FLOOR = 5;

// Filter rows to those whose key is backed by at least `k` distinct refs.
// keyFn(row) → grouping key (e.g. normalized label); refFn(row) → the
// distinct-count unit (e.g. anon pairing_ref).
export function applyKFloor(rows, keyFn, refFn, k = K_ANON_FLOOR) {
  const refsByKey = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!refsByKey.has(key)) refsByKey.set(key, new Set());
    refsByKey.get(key).add(refFn(row));
  }
  return rows.filter((row) => refsByKey.get(keyFn(row)).size >= k);
}
