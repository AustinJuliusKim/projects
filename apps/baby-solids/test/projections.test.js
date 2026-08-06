import test from "node:test";
import assert from "node:assert/strict";
import { foodStatus, allergenWindow, reactionLog, categoryCoverage } from "../src/store/projections.js";

const BABY = "99999999-9999-4999-8999-999999999999";
let seq = 0;
const uid = () => `${String(++seq).padStart(8, "0")}-1111-4111-8111-111111111111`;

function exposure(foodId, ts, extra = {}) {
  return {
    id: uid(),
    babyId: BABY,
    ts,
    tz: "America/Los_Angeles",
    kind: "food_exposure",
    payload: { foodId, amount: "some", ...extra },
    source: "baby-solids",
    deviceId: "d1",
    createdAt: ts,
    revision: 0,
    deleted: false,
  };
}

test("foodStatus counts exposures rather than flagging a boolean", () => {
  const s = foodStatus([
    exposure("broccoli", "2026-09-01T12:00:00-07:00", { amount: "none" }),
    exposure("broccoli", "2026-09-03T12:00:00-07:00", { amount: "tasted" }),
    exposure("broccoli", "2026-09-05T12:00:00-07:00", { amount: "some" }),
  ]);
  assert.equal(s.broccoli.count, 3);
  assert.equal(s.broccoli.bestAmount, "some");
  assert.equal(s.broccoli.everRefused, true, "a refusal is progress toward ~8, not a failure");
  assert.equal(s.broccoli.firstAt, "2026-09-01T12:00:00-07:00");
  assert.equal(s.broccoli.lastAt, "2026-09-05T12:00:00-07:00");
});

test("a tombstoned exposure leaves the projection but stays in the log", () => {
  const live = exposure("pear", "2026-09-01T12:00:00-07:00");
  const gone = { ...exposure("pear", "2026-09-02T12:00:00-07:00"), deleted: true };
  const log = [live, gone];
  assert.equal(foodStatus(log).pear.count, 1, "the tombstone must not be counted");
  assert.equal(log.length, 2, "but it must still be present in the raw log for sync");
});

test("categoryCoverage reports spread, not just a total", () => {
  const status = foodStatus([
    exposure("pear", "2026-09-01T12:00:00-07:00"),
    exposure("peas", "2026-09-01T12:00:00-07:00"),
    exposure("beef", "2026-09-01T12:00:00-07:00"),
  ]);
  const coverage = categoryCoverage(status, {
    pear: { category: "fruit" },
    peas: { category: "vegetable" },
    beef: { category: "animal_protein" },
  });
  assert.deepEqual(coverage, { fruit: 1, vegetable: 1, animal_protein: 1 });
});

const PLANS = [{ allergen: "peanut", status: "maintaining", targetSessionsPerWeek: 3, targetGramsPerWeek: 6 }];

test("allergenWindow counts sessions and grams inside a rolling 7 days", () => {
  const events = [
    exposure("peanut", "2026-09-10T09:00:00-07:00", { allergen: "peanut", allergenDoseG: 2 }),
    exposure("peanut", "2026-09-12T09:00:00-07:00", { allergen: "peanut", allergenDoseG: 2 }),
    exposure("peanut", "2026-09-14T09:00:00-07:00", { allergen: "peanut", allergenDoseG: 2 }),
  ];
  const [w] = allergenWindow(events, PLANS, "2026-09-15T09:00:00-07:00");
  assert.equal(w.sessionsLast7d, 3);
  assert.equal(w.gramsLast7d, 6);
  assert.equal(w.dueToday, false, "target met");
  assert.equal(w.daysSinceLast, 1);
});

test("the window is ROLLING — advancing now drops a session out of range", () => {
  const events = [
    exposure("peanut", "2026-09-10T09:00:00-07:00", { allergen: "peanut", allergenDoseG: 2 }),
    exposure("peanut", "2026-09-12T09:00:00-07:00", { allergen: "peanut", allergenDoseG: 2 }),
    exposure("peanut", "2026-09-14T09:00:00-07:00", { allergen: "peanut", allergenDoseG: 2 }),
  ];
  // One day later the 09-10 session falls outside the trailing week. A
  // Monday-resetting counter would still be reporting a comfortable 3/3.
  const [w] = allergenWindow(events, PLANS, "2026-09-17T10:00:00-07:00");
  assert.equal(w.sessionsLast7d, 2);
  assert.equal(w.dueToday, true, "falling behind must surface the day it happens");
});

test("an allergen that was never served reports no last-served date", () => {
  const [w] = allergenWindow([], PLANS, "2026-09-15T09:00:00-07:00");
  assert.equal(w.daysSinceLast, null);
  assert.equal(w.lastAt, null);
  assert.equal(w.sessionsLast7d, 0);
  assert.equal(w.dueToday, true);
});

test("a not-yet-started or gated allergen is never nagged", () => {
  const gated = [{ allergen: "peanut", status: "medical_gate_pending" }];
  const [w] = allergenWindow([], gated, "2026-09-15T09:00:00-07:00");
  assert.equal(w.dueToday, false, "a clinician conversation is not a chore to nag about");

  const notStarted = [{ allergen: "egg", status: "not_started" }];
  assert.equal(allergenWindow([], notStarted, "2026-09-15T09:00:00-07:00")[0].dueToday, false);
});

test("allergenWindow is pure — same inputs, same output, no clock read", () => {
  const events = [exposure("peanut", "2026-09-14T09:00:00-07:00", { allergen: "peanut" })];
  const a = allergenWindow(events, PLANS, "2026-09-15T09:00:00-07:00");
  const b = allergenWindow(events, PLANS, "2026-09-15T09:00:00-07:00");
  assert.deepEqual(a, b);
});

test("reactionLog joins a reaction to the exposure it followed", () => {
  const meal = exposure("peanut", "2026-09-14T09:00:00-07:00", { allergen: "peanut" });
  const reaction = {
    ...exposure("peanut", "2026-09-14T09:40:00-07:00"),
    kind: "reaction",
    payload: {
      relatedExposureId: meal.id,
      symptoms: ["hives"],
      severity: "mild",
      onsetMinutes: 40,
      actionTaken: "watched",
    },
  };
  const [entry] = reactionLog([meal, reaction]);
  assert.equal(entry.severity, "mild");
  assert.equal(entry.onsetMinutes, 40);
  assert.equal(entry.relatedExposure.id, meal.id, "logged 40 min later, still linked");
  assert.equal(foodStatus([meal, reaction]).peanut.hasReaction, true);
});
