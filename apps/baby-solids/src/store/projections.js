/**
 * Derived views over the event log. All pure, all deterministic.
 *
 * `now` is always a parameter, never `new Date()` inside a projection — the
 * rolling-window logic is the most testable thing in the app and it would be
 * untestable the moment it read the clock itself.
 */

import { liveEvents } from "@baby/core";

/** Exposures generally needed before acceptance (NESR review: 8-10+). */
export const ACCEPTANCE_EXPOSURES = 8;

/**
 * Per-food exposure state.
 *
 * `count` is a count, not a boolean, because "tried it" is the wrong model:
 * a food offered once and refused is at the start of a normal 8-10 exposure
 * arc, not a failure.
 *
 * @param {import("@baby/core").TimelineEvent[]} events
 * @returns {Record<string, {count: number, firstAt: string, lastAt: string,
 *   bestAmount: string, everRefused: boolean, hasReaction: boolean}>}
 */
export function foodStatus(events) {
  const live = liveEvents(events);
  const AMOUNT_RANK = { none: 0, tasted: 1, some: 2, most: 3 };
  const reactedFoodIds = new Set();
  const exposureById = new Map();

  for (const e of live) {
    if (e.kind === "food_exposure") exposureById.set(e.id, e.payload?.foodId);
  }
  for (const e of live) {
    if (e.kind !== "reaction") continue;
    const foodId = e.payload?.foodId ?? exposureById.get(e.payload?.relatedExposureId);
    if (foodId) reactedFoodIds.add(foodId);
  }

  /** @type {Record<string, any>} */
  const out = {};
  for (const e of live) {
    if (e.kind !== "food_exposure") continue;
    const foodId = e.payload?.foodId;
    if (!foodId) continue;
    const amount = e.payload?.amount ?? "tasted";
    const cur = out[foodId];
    if (!cur) {
      out[foodId] = {
        count: 1,
        firstAt: e.ts,
        lastAt: e.ts,
        bestAmount: amount,
        everRefused: amount === "none",
        hasReaction: reactedFoodIds.has(foodId),
      };
      continue;
    }
    cur.count += 1;
    if (e.ts < cur.firstAt) cur.firstAt = e.ts;
    if (e.ts > cur.lastAt) cur.lastAt = e.ts;
    if ((AMOUNT_RANK[amount] ?? 0) > (AMOUNT_RANK[cur.bestAmount] ?? 0)) cur.bestAmount = amount;
    if (amount === "none") cur.everRefused = true;
  }
  return out;
}

/**
 * How many distinct foods have been tried per category.
 *
 * The "100 foods" count on its own is a weak signal — repeated-exposure
 * benefits generalize *within* a food category but not across it, so 100
 * foods bunched into two categories is worth less than a spread. The board
 * shows coverage, not just a number.
 *
 * @param {Record<string, {count: number}>} status
 * @param {Record<string, {category: string}>} foodsById
 */
export function categoryCoverage(status, foodsById) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const foodId of Object.keys(status)) {
    const cat = foodsById[foodId]?.category;
    if (cat) out[cat] = (out[cat] ?? 0) + 1;
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * Allergen maintenance state over a ROLLING seven days.
 *
 * Rolling, not a weekly reset: "three times a week" in practice means "don't
 * let more than a couple of days lapse", and a Monday-resets counter would
 * report a comfortable 3/3 for someone who served everything last Sunday and
 * nothing since.
 *
 * This exists because introduction is not the finish line. CSACI's position
 * is that occasional exposure after introduction may be worse than none —
 * so the app tracks a decay clock, not a checkbox.
 *
 * @param {import("@baby/core").TimelineEvent[]} events
 * @param {{allergen: string, status: string, targetGramsPerWeek?: number,
 *          targetSessionsPerWeek?: number}[]} plans
 * @param {Date|string} now
 */
export function allergenWindow(events, plans, now) {
  const nowMs = new Date(now).getTime();
  const cutoff = nowMs - 7 * DAY_MS;
  const live = liveEvents(events).filter((e) => e.kind === "food_exposure");

  return plans.map((plan) => {
    const mine = live.filter((e) => e.payload?.allergen === plan.allergen);
    const recent = mine.filter((e) => new Date(e.ts).getTime() > cutoff);
    const lastAt = mine.reduce((max, e) => (max && max > e.ts ? max : e.ts), null);
    const daysSinceLast =
      lastAt === null ? null : Math.floor((nowMs - new Date(lastAt).getTime()) / DAY_MS);

    const targetSessions = plan.targetSessionsPerWeek ?? 3;
    const targetGrams = plan.targetGramsPerWeek ?? 6;
    const sessionsLast7d = recent.length;
    const gramsLast7d = recent.reduce((sum, e) => sum + (e.payload?.allergenDoseG ?? 0), 0);

    // Only an actively-maintained allergen can be "due" — a not-yet-started
    // one is a decision to make, not a chore to nag about, and one that's
    // gated on a clinician conversation must never be nagged at all.
    const active = plan.status === "introducing" || plan.status === "maintaining";

    return {
      allergen: plan.allergen,
      status: plan.status,
      sessionsLast7d,
      gramsLast7d: Math.round(gramsLast7d * 100) / 100,
      targetSessions,
      targetGrams,
      daysSinceLast,
      lastAt,
      dueToday: active && sessionsLast7d < targetSessions,
    };
  });
}

/**
 * Reactions, newest first, joined to the exposure that preceded them.
 *
 * @param {import("@baby/core").TimelineEvent[]} events
 */
export function reactionLog(events) {
  const live = liveEvents(events);
  const byId = new Map(live.map((e) => [e.id, e]));
  return live
    .filter((e) => e.kind === "reaction")
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      symptoms: e.payload?.symptoms ?? [],
      severity: e.payload?.severity ?? "mild",
      onsetMinutes: e.payload?.onsetMinutes ?? null,
      actionTaken: e.payload?.actionTaken ?? null,
      relatedExposure: byId.get(e.payload?.relatedExposureId) ?? null,
    }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}
