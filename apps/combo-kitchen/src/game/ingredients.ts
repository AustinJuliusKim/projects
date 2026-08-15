import type { Ingredient } from "./types.ts";

export const INGREDIENTS: readonly Ingredient[] = [
  { id: "cheese", name: "Cheese" },
  { id: "bacon", name: "Bacon" },
  { id: "pasta", name: "Pasta" },
  { id: "meat", name: "Meat" },
  { id: "potato", name: "Potato" },
  { id: "flour", name: "Flour" },
  { id: "chicken", name: "Chicken" },
  { id: "rice", name: "Rice" },
  { id: "egg", name: "Egg" },
  { id: "tomato", name: "Tomato" },
  { id: "fish", name: "Fish" },
  { id: "bread", name: "Bread" },
  { id: "chocolate", name: "Chocolate" },
  { id: "apple", name: "Apple" },
  { id: "milk", name: "Milk" },
];

const byId = new Map(INGREDIENTS.map((i) => [i.id, i]));

export function ingredientById(id: string): Ingredient | undefined {
  return byId.get(id as Ingredient["id"]);
}
