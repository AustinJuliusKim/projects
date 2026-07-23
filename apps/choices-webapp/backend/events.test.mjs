// events.mjs: envelope shape, per-type validation (the privacy gate),
// anonymization, daily salt rotation, outbox item shape, k-floor helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  buildEvent,
  eventItem,
  utcDayFromTs,
  deriveDailySalt,
  anonRef,
  toAnonEnvelope,
  K_ANON_FLOOR,
  applyKFloor,
} from "./events.mjs";

// One known-good payload per catalog type. Doubles as the registry-coverage
// check: a type added without a happy payload here fails the loop below.
const HAPPY = {
  game_created: { game_number: 1, choice_count: 4, source: "manual" },
  seat_claimed: { seat: "B", first_claim: true, signed_in: false },
  cut_made: { game_number: 2, cut_number: 1, index: 3 },
  game_finished: {
    game_number: 2,
    winner_index: 3,
    winner_label: "Ramen",
    choices: ["Pizza", "Tacos", "Sushi", "Ramen"],
    duration_ms: 61_000,
  },
  rematch: { game_number: 3, choice_count: 4, source: "fill4" },
  push_sent: { trigger: "your_turn" },
  link_clicked: { platform: "ubereats" },
  suggestion_accepted: { layer: "trie" },
  fill4_used: { context: "pairing", premium: false, uses_left: 2 },
  invite_link_opened: { via: "link" },
  join_abandoned: {},
  reveal_viewed: { game_number: 1 },
  reveal_card_shared: {},
  pwa_installed: { platform: "web" },
  push_permission_result: { result: "granted" },
  suggestion_shown: { layer: "places", count: 5 },
  fill4_shown: { context: "create" },
  fill4_swapped: { swap_count: 2 },
  order_click: { platform: "doordash" },
  paywall_viewed: { surface: "history-lock" },
  sub_started: { plan: "monthly" },
  sub_cancelled: {},
  tip_given: { platform: "tip-venmo" },
  client_error: { error_type: "js_error" },
  realtime_fallback: {},
  pairing_deleted: { reason: "ttl" },
  flag_changed: {
    flag: "ops_kill_fill4",
    enabled_old: false,
    enabled_new: true,
    default_old: false,
    default_new: false,
    updated_by: "admin",
  },
};

test("registry covers the frozen catalog (25 types) + pairing_deleted + bundle E", () => {
  const types = Object.keys(EVENT_TYPES);
  assert.equal(types.length, 27);
  assert.deepEqual(new Set(types), new Set(Object.keys(HAPPY)));
});

test("every type validates its happy payload", () => {
  for (const [type, payload] of Object.entries(HAPPY)) {
    assert.equal(EVENT_TYPES[type].validate(payload), true, type);
  }
});

test("buildEvent returns the frozen envelope shape", () => {
  const now = Date.UTC(2026, 6, 12, 3, 14, 15, 926);
  const ev = buildEvent(
    "cut_made",
    { pairingRef: "abc123def456", actorRole: "B", payload: HAPPY.cut_made },
    now
  );
  assert.deepEqual(Object.keys(ev).sort(), [
    "actor_role",
    "event_id",
    "pairing_ref",
    "payload",
    "schema_v",
    "ts",
    "type",
  ]);
  assert.match(ev.event_id, /^[0-9a-f-]{36}$/);
  assert.equal(ev.ts, "2026-07-12T03:14:15.926Z");
  assert.equal(ev.type, "cut_made");
  assert.equal(ev.schema_v, 2);
  assert.equal(ev.pairing_ref, "abc123def456");
  assert.equal(ev.actor_role, "B");
  assert.deepEqual(ev.payload, HAPPY.cut_made);
});

test("buildEvent throws on unknown types, bad payloads, bad roles", () => {
  assert.throws(() => buildEvent("made_up_type", { payload: {} }));
  assert.throws(() =>
    buildEvent("push_sent", { actorRole: "system", payload: { trigger: "spam" } })
  );
  assert.throws(() =>
    buildEvent("push_sent", { actorRole: "C", payload: HAPPY.push_sent })
  );
  // null payload / non-object payloads never pass.
  assert.throws(() => buildEvent("join_abandoned", { payload: null }));
  assert.throws(() => buildEvent("join_abandoned", { payload: "free text" }));
});

test("client-event validators reject free text in every field and any extra key", () => {
  const TYPED = "I typed this myself 😏";
  for (const type of Object.keys(CLIENT_EVENT_TYPES)) {
    const happy = HAPPY[type];
    const { validate } = EVENT_TYPES[type];
    // Unknown keys are rejected — no free-form field can ride along.
    assert.equal(validate({ ...happy, note: TYPED }), false, `${type} extra key`);
    // Every existing field rejects an arbitrary string.
    for (const key of Object.keys(happy)) {
      assert.equal(
        validate({ ...happy, [key]: TYPED }),
        false,
        `${type}.${key} accepts free text`
      );
    }
    // Non-object payloads are rejected outright.
    assert.equal(validate(TYPED), false, `${type} string payload`);
    assert.equal(validate(null), false, `${type} null payload`);
  }
});

test("client scopes cover exactly the trackable types", () => {
  assert.deepEqual(CLIENT_EVENT_TYPES, {
    suggestion_accepted: "pairing",
    invite_link_opened: "code",
    join_abandoned: "code",
    reveal_viewed: "pairing",
    pwa_installed: "none",
    push_permission_result: "optional",
    suggestion_shown: "optional",
    fill4_shown: "optional",
    fill4_swapped: "optional",
    paywall_viewed: "optional",
    client_error: "none",
  });
});

test("bounded ints are enforced (no unbounded numeric smuggling)", () => {
  const v = EVENT_TYPES.suggestion_shown.validate;
  assert.equal(v({ layer: "pair", count: 51 }), false);
  assert.equal(v({ layer: "pair", count: -1 }), false);
  assert.equal(v({ layer: "pair", count: 3.5 }), false);
  assert.equal(v({ layer: "pair", count: 3 }), true);
  const cut = EVENT_TYPES.cut_made.validate;
  // Variable choice count (3–8): up to 7 cuts / index 7 are legal, 8 is not.
  assert.equal(cut({ ...HAPPY.cut_made, cut_number: 7, index: 7 }), true);
  assert.equal(cut({ ...HAPPY.cut_made, cut_number: 8 }), false);
  assert.equal(cut({ ...HAPPY.cut_made, index: 8 }), false);
});

test("game_finished accepts 3–8 choices, rejects outside the range", () => {
  const v = EVENT_TYPES.game_finished.validate;
  const base = HAPPY.game_finished;
  const labels = (n) => Array.from({ length: n }, (_, i) => `Choice ${i + 1}`);
  assert.equal(v({ ...base, choices: labels(3), winner_index: 2 }), true);
  assert.equal(v({ ...base, choices: labels(8), winner_index: 7 }), true);
  assert.equal(v({ ...base, choices: labels(2), winner_index: 1 }), false);
  assert.equal(v({ ...base, choices: labels(9), winner_index: 0 }), false);
  assert.equal(v({ ...base, winner_index: 8 }), false);
});

test("eventItem flattens the envelope onto an EVENT# put with a 2-day ttl", () => {
  const ev = buildEvent(
    "seat_claimed",
    { pairingRef: "abc123", actorRole: "B", payload: HAPPY.seat_claimed },
    Date.UTC(2026, 6, 12)
  );
  const { Put } = eventItem(ev, "test-table");
  assert.equal(Put.TableName, "test-table");
  assert.equal(Put.Item.pk, `EVENT#${ev.event_id}`);
  assert.equal(Put.Item.type, "seat_claimed");
  assert.equal(Put.Item.ttl, Math.floor(Date.UTC(2026, 6, 12) / 1000) + 2 * 24 * 3600);
  assert.deepEqual(Put.Item.payload, HAPPY.seat_claimed);
});

test("utcDayFromTs derives the dt partition from the envelope ts", () => {
  assert.equal(utcDayFromTs("2026-07-12T03:14:15.926Z"), "2026-07-12");
  assert.equal(utcDayFromTs("2026-12-31T23:59:59.999Z"), "2026-12-31");
});

test("daily salt is stable within a day and rotates across days", () => {
  const master = "master-salt";
  const d1 = deriveDailySalt(master, "2026-07-12");
  const d1again = deriveDailySalt(master, "2026-07-12");
  const d2 = deriveDailySalt(master, "2026-07-13");
  assert.deepEqual(d1, d1again);
  assert.notDeepEqual(d1, d2);

  const sameDayA = anonRef(master, "abc123", "2026-07-12T01:00:00.000Z");
  const sameDayB = anonRef(master, "abc123", "2026-07-12T23:59:00.000Z");
  const nextDay = anonRef(master, "abc123", "2026-07-13T01:00:00.000Z");
  assert.equal(sameDayA, sameDayB); // linkable within a UTC day
  assert.notEqual(sameDayA, nextDay); // unlinkable across days
  assert.match(sameDayA, /^[0-9a-f]{16}$/);
  assert.ok(!sameDayA.includes("abc123"));
});

test("anonRef differs per pairing and per master salt", () => {
  const ts = "2026-07-12T01:00:00.000Z";
  assert.notEqual(anonRef("m1", "pair-a", ts), anonRef("m1", "pair-b", ts));
  assert.notEqual(anonRef("m1", "pair-a", ts), anonRef("m2", "pair-a", ts));
});

test("toAnonEnvelope replaces the ref and normalizes game_finished labels", () => {
  const ev = buildEvent(
    "game_finished",
    {
      pairingRef: "abc123def456",
      actorRole: "A",
      payload: {
        game_number: 1,
        winner_index: 0,
        winner_label: "  Pizza  Time ",
        choices: ["  Pizza  Time ", "Tacos", "Sushi", "Ramen"],
        duration_ms: 1000,
      },
    },
    Date.UTC(2026, 6, 12)
  );
  const anon = toAnonEnvelope(ev, "master-salt");
  assert.equal(anon.event_id, ev.event_id);
  assert.equal(anon.pairing_ref, anonRef("master-salt", "abc123def456", ev.ts));
  assert.ok(!JSON.stringify(anon).includes("abc123def456"));
  assert.equal(anon.payload.winner_label, "pizza time");
  assert.deepEqual(anon.payload.choices, ["pizza time", "tacos", "sushi", "ramen"]);
  // The raw envelope is untouched (new object out).
  assert.equal(ev.payload.winner_label, "  Pizza  Time ");
  assert.equal(ev.pairing_ref, "abc123def456");
});

test("toAnonEnvelope copies structural payloads and keeps null refs null", () => {
  const ev = buildEvent("pwa_installed", { payload: { platform: "web" } });
  const anon = toAnonEnvelope(ev, "master-salt");
  assert.equal(anon.pairing_ref, null);
  assert.deepEqual(anon.payload, { platform: "web" });
});

test("applyKFloor drops keys below the distinct-ref floor", () => {
  assert.equal(K_ANON_FLOOR, 5);
  const rows = [
    // "ramen" seen by 5 distinct refs — survives.
    ...[1, 2, 3, 4, 5].map((i) => ({ label: "ramen", ref: `r${i}` })),
    // "durian" seen by 4 refs (one duplicated) — dropped.
    ...[1, 1, 2, 3, 4].map((i) => ({ label: "durian", ref: `r${i}` })),
  ];
  const kept = applyKFloor(rows, (r) => r.label, (r) => r.ref);
  assert.equal(kept.length, 5);
  assert.ok(kept.every((r) => r.label === "ramen"));
  // Lower explicit floor keeps both.
  assert.equal(applyKFloor(rows, (r) => r.label, (r) => r.ref, 4).length, 10);
});
