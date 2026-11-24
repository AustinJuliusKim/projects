/**
 * The one piece of app state: the event log, plus the writes that append to
 * it. Deliberately a plain hook over localStorage — no state library, matching
 * the repo's other apps.
 */

import { useCallback, useMemo, useState } from "react";
import { loadEvents, appendEvent, deleteEvent } from "./store/eventStore.js";
import { foodStatus, allergenWindow, reactionLog, categoryCoverage } from "./store/projections.js";
import foodsData from "./generated/foods.json";

/** Placeholder until a profile screen exists; stable so events group correctly. */
export const BABY_ID = "00000000-0000-4000-8000-000000000000";

export const FOODS = foodsData.foods;
export const SEARCH_INDEX = foodsData.index;
export const FOODS_BY_ID = Object.fromEntries(FOODS.map((f) => [f.id, f]));

/** One plan per allergen the canon can introduce, derived from the food records. */
export const ALLERGEN_FOODS = FOODS.filter((f) => f.allergenProtocol);

/**
 * Builds allergen plans against the actual log.
 *
 * Status is derived, not fixed, and that matters more with nine allergens
 * than with one: a plan that starts life as "introducing" would have every
 * allergen nagging from day one, including ones you have consciously not
 * started yet. An allergen never served is a decision still to make, not a
 * chore you are behind on — only once it has actually been served does the
 * maintenance clock start, because only then does lapsing carry the risk
 * CSACI describes.
 *
 * @param {import("@baby/core").TimelineEvent[]} events
 */
export function buildAllergenPlans(events) {
  const served = new Set(
    events
      .filter((e) => !e.deleted && e.kind === "food_exposure" && e.payload?.allergen)
      .map((e) => e.payload.allergen),
  );
  return ALLERGEN_FOODS.map((f) => ({
    allergen: f.allergenProtocol.allergen,
    foodId: f.id,
    status: served.has(f.allergenProtocol.allergen) ? "maintaining" : "not_started",
    targetSessionsPerWeek: f.allergenProtocol.maintenanceMinSessionsPerWeek ?? 3,
    targetGramsPerWeek: f.allergenProtocol.maintenanceProteinGPerWeek ?? 6,
    medicalGate: f.allergenProtocol.medicalGate,
  }));
}

export function useLog() {
  const [events, setEvents] = useState(() => loadEvents());
  const [now, setNow] = useState(() => new Date());

  const logFoods = useCallback((foodIds, amount = "tasted") => {
    let next = events;
    for (const foodId of foodIds) {
      const food = FOODS_BY_ID[foodId];
      next = appendEvent({
        babyId: BABY_ID,
        kind: "food_exposure",
        payload: {
          foodId,
          amount,
          // Carried on the event so the allergen projection stays pure — it
          // never has to reach back into the food canon.
          ...(food?.allergenProtocol ? { allergen: food.allergenProtocol.allergen } : {}),
        },
      });
    }
    setEvents(next);
    setNow(new Date());
  }, [events]);

  const removeEvent = useCallback((id) => setEvents(deleteEvent(id)), []);

  const status = useMemo(() => foodStatus(events), [events]);
  const coverage = useMemo(() => categoryCoverage(status, FOODS_BY_ID), [status]);
  const plans = useMemo(() => buildAllergenPlans(events), [events]);
  const allergens = useMemo(() => allergenWindow(events, plans, now), [events, plans, now]);
  const reactions = useMemo(() => reactionLog(events), [events]);

  return { events, status, coverage, plans, allergens, reactions, logFoods, removeEvent };
}
