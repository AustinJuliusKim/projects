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

/** Allergen plans derived from the canon — every food carrying a protocol. */
export const ALLERGEN_PLANS = FOODS.filter((f) => f.allergenProtocol).map((f) => ({
  allergen: f.allergenProtocol.allergen,
  foodId: f.id,
  status: "introducing",
  targetSessionsPerWeek: f.allergenProtocol.maintenanceMinSessionsPerWeek ?? 3,
  targetGramsPerWeek: f.allergenProtocol.maintenanceProteinGPerWeek ?? 6,
  medicalGate: f.allergenProtocol.medicalGate,
}));

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
  const allergens = useMemo(() => allergenWindow(events, ALLERGEN_PLANS, now), [events, now]);
  const reactions = useMemo(() => reactionLog(events), [events]);

  return { events, status, coverage, allergens, reactions, logFoods, removeEvent };
}
