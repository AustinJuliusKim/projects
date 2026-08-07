import test from "node:test";
import assert from "node:assert/strict";
import { mergeEvents, liveEvents } from "../merge.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const BABY = "99999999-9999-4999-8999-999999999999";

/** @returns {import("../schemas.js").TimelineEvent} */
function ev(id, overrides = {}) {
  return {
    id,
    babyId: BABY,
    ts: "2026-09-14T17:32:00-07:00",
    tz: "America/Los_Angeles",
    kind: "food_exposure",
    payload: { foodId: "sweet-potato" },
    source: "baby-solids",
    deviceId: "device-1",
    createdAt: "2026-09-14T17:32:01-07:00",
    revision: 0,
    deleted: false,
    ...overrides,
  };
}

test("merge is commutative — either device may sync first", () => {
  const a = [ev(ID_A), ev(ID_B, { ts: "2026-09-15T08:00:00-07:00" })];
  const b = [ev(ID_C, { ts: "2026-09-13T08:00:00-07:00" }), ev(ID_A, { revision: 2 })];
  assert.deepEqual(mergeEvents(a, b), mergeEvents(b, a));
});

test("merge is commutative even when revisions tie", () => {
  // Same id, same revision, different content: without a total order this is
  // where merge silently depends on argument order.
  const a = [ev(ID_A, { deviceId: "phone", payload: { foodId: "pear" } })];
  const b = [ev(ID_A, { deviceId: "tablet", payload: { foodId: "plum" } })];
  assert.deepEqual(mergeEvents(a, b), mergeEvents(b, a));
});

test("merge is idempotent", () => {
  const a = [ev(ID_A), ev(ID_B, { ts: "2026-09-15T08:00:00-07:00" })];
  assert.deepEqual(mergeEvents(a, a), mergeEvents(a));
  assert.deepEqual(mergeEvents(mergeEvents(a), a), mergeEvents(a));
});

test("higher revision wins", () => {
  const merged = mergeEvents(
    [ev(ID_A, { revision: 1, payload: { foodId: "old" } })],
    [ev(ID_A, { revision: 5, payload: { foodId: "new" } })],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].revision, 5);
  assert.equal(merged[0].payload.foodId, "new");
});

test("a tombstone survives merging with a device that still holds the live event", () => {
  const deletedSide = [ev(ID_A, { revision: 1, deleted: true })];
  const staleSide = [ev(ID_A, { revision: 0, deleted: false })];
  const merged = mergeEvents(deletedSide, staleSide);
  assert.equal(merged.length, 1, "the tombstone must remain in the log, not vanish");
  assert.equal(merged[0].deleted, true);
  assert.deepEqual(liveEvents(merged), [], "and must not surface in projections");
});

test("a tombstone is not resurrected by a later merge", () => {
  const deleted = mergeEvents([ev(ID_A, { revision: 1, deleted: true })]);
  // A third device that never saw the delete syncs its old copy back in.
  const laggard = [ev(ID_A, { revision: 0, deleted: false })];
  const again = mergeEvents(deleted, laggard);
  assert.equal(again[0].deleted, true);
  assert.deepEqual(liveEvents(again), []);
});

test("merge sorts by ts and never mutates its inputs", () => {
  const a = [ev(ID_B, { ts: "2026-09-15T08:00:00-07:00" })];
  const b = [ev(ID_A, { ts: "2026-09-13T08:00:00-07:00" })];
  const frozenA = JSON.stringify(a);
  const merged = mergeEvents(a, b);
  assert.deepEqual(
    merged.map((e) => e.ts),
    ["2026-09-13T08:00:00-07:00", "2026-09-15T08:00:00-07:00"],
  );
  assert.equal(JSON.stringify(a), frozenA, "inputs must not be mutated");
});

test("unknown kinds round-trip intact — the convergence contract", () => {
  // A nap from Little Rhythm must survive a merge in this app untouched.
  const ours = [ev(ID_A)];
  const theirs = [ev(ID_B, { kind: "nap", source: "little-rhythm", payload: { durationMin: 45 } })];
  const merged = mergeEvents(ours, theirs);
  const nap = merged.find((e) => e.id === ID_B);
  assert.equal(nap.kind, "nap");
  assert.equal(nap.payload.durationMin, 45);
});
