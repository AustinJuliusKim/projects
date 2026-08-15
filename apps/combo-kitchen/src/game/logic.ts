import type { Dish, IngredientId } from "./types.ts";
import { DISHES } from "./combos.ts";
import { ingredientById } from "./ingredients.ts";

export function comboKey(ids: readonly IngredientId[]): string {
  if (ids.length !== 3) {
    throw new Error(`a combo needs exactly 3 ingredients, got ${ids.length}`);
  }
  if (new Set(ids).size !== 3) {
    throw new Error(`a combo can't repeat an ingredient: ${ids.join("+")}`);
  }
  return [...ids].sort().join("+");
}

function buildIndex(): ReadonlyMap<string, Dish> {
  const index = new Map<string, Dish>();
  for (const dish of DISHES) {
    const key = comboKey(dish.combo);
    if (index.has(key)) {
      throw new Error(`duplicate combo ${key}: ${index.get(key)!.name} vs ${dish.name}`);
    }
    index.set(key, dish);
  }
  return index;
}

export const COMBO_INDEX: ReadonlyMap<string, Dish> = buildIndex();

export function findDish(ids: readonly IngredientId[]): Dish | undefined {
  return COMBO_INDEX.get(comboKey(ids));
}

const MYSTERY_FLAVOR = [
  "The pot has questions. So do we.",
  "Science was done here today.",
  "It's... glowing a little. Probably fine.",
  "The smoke alarm gave it one star. Critics disagree.",
];

export function mysteryDish(
  ids: readonly IngredientId[],
  rng: () => number = Math.random,
): Dish {
  const sorted = [...ids].sort();
  const names = sorted.map((id) => ingredientById(id)?.name.toLowerCase() ?? id);
  const flavorText = MYSTERY_FLAVOR[Math.floor(rng() * MYSTERY_FLAVOR.length)];
  return {
    id: "mystery-stew",
    name: "Mystery Stew",
    combo: [sorted[0], sorted[1], sorted[2]],
    flavorText,
    recipe: {
      ingredients: [
        `Some ${names[0]}`,
        `An amount of ${names[1]}`,
        `The ${names[2]}, unfortunately`,
        "1 pot you don't mind explaining later",
        "Seasoning: courage",
      ],
      steps: [
        `Stare at the ${names[0]} for a while. Add it anyway.`,
        `Introduce the ${names[1]} to the ${names[2]}. They will not get along.`,
        "Stir until something changes. Anything.",
        "Simmer until the kitchen smells like a decision.",
        "Serve with confidence. Confidence is the garnish.",
      ],
    },
  };
}

export function cook(
  ids: readonly IngredientId[],
  rng: () => number = Math.random,
): { dish: Dish; isMystery: boolean } {
  const dish = findDish(ids);
  if (dish) return { dish, isMystery: false };
  return { dish: mysteryDish(ids, rng), isMystery: true };
}
