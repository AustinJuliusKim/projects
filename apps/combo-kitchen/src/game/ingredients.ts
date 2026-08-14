import type { Ingredient } from "./types.ts";

export const INGREDIENTS: readonly Ingredient[] = [
  { id: "cheese", name: "Cheese", emoji: "🧀" },
  { id: "bacon", name: "Bacon", emoji: "🥓" },
  { id: "pasta", name: "Pasta", emoji: "🍝" },
  { id: "meat", name: "Meat", emoji: "🥩" },
  { id: "potato", name: "Potato", emoji: "🥔" },
  { id: "flour", name: "Flour", emoji: "🌾" },
  { id: "chicken", name: "Chicken", emoji: "🍗" },
  { id: "rice", name: "Rice", emoji: "🍚" },
  { id: "egg", name: "Egg", emoji: "🥚" },
  { id: "tomato", name: "Tomato", emoji: "🍅" },
  { id: "fish", name: "Fish", emoji: "🐟" },
  { id: "bread", name: "Bread", emoji: "🍞" },
  { id: "chocolate", name: "Chocolate", emoji: "🍫" },
  { id: "apple", name: "Apple", emoji: "🍎" },
  { id: "milk", name: "Milk", emoji: "🥛" },
];

const byId = new Map(INGREDIENTS.map((i) => [i.id, i]));

export function ingredientById(id: string): Ingredient | undefined {
  return byId.get(id as Ingredient["id"]);
}
