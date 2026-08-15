import type { Dish } from "./types.ts";
import { DISHES } from "./combos.ts";

export const COOKBOOK_STORAGE_KEY = "combo-kitchen.cookbook.v1";

export interface CookbookState {
  version: 1;
  discovered: Record<string, { firstCookedAt: string }>;
}

export function emptyCookbook(): CookbookState {
  return { version: 1, discovered: {} };
}

export function parseCookbook(raw: string | null): CookbookState {
  if (!raw) return emptyCookbook();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { discovered?: unknown }).discovered !== "object" ||
      (parsed as { discovered?: unknown }).discovered === null
    ) {
      return emptyCookbook();
    }
    const discovered: CookbookState["discovered"] = {};
    for (const [id, entry] of Object.entries(
      (parsed as { discovered: Record<string, unknown> }).discovered,
    )) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { firstCookedAt?: unknown }).firstCookedAt === "string"
      ) {
        discovered[id] = { firstCookedAt: (entry as { firstCookedAt: string }).firstCookedAt };
      }
    }
    return { version: 1, discovered };
  } catch {
    return emptyCookbook();
  }
}

export function serializeCookbook(state: CookbookState): string {
  return JSON.stringify(state);
}

export function recordDiscovery(
  state: CookbookState,
  dish: Dish,
  now: Date = new Date(),
): { state: CookbookState; isNew: boolean } {
  if (state.discovered[dish.id]) {
    return { state, isNew: false };
  }
  return {
    state: {
      version: 1,
      discovered: { ...state.discovered, [dish.id]: { firstCookedAt: now.toISOString() } },
    },
    isNew: true,
  };
}

export function discoveredDishes(state: CookbookState): Dish[] {
  return DISHES.filter((dish) => state.discovered[dish.id]);
}
