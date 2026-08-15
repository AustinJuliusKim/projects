export type IngredientId =
  | "cheese"
  | "bacon"
  | "pasta"
  | "meat"
  | "potato"
  | "flour"
  | "chicken"
  | "rice"
  | "egg"
  | "tomato"
  | "fish"
  | "bread"
  | "chocolate"
  | "apple"
  | "milk";

export interface Ingredient {
  id: IngredientId;
  name: string;
}

export interface Recipe {
  ingredients: string[];
  steps: string[];
}

// Dish ids double as sprite keys in src/sprites/data.ts.
export interface Dish {
  id: string;
  name: string;
  combo: [IngredientId, IngredientId, IngredientId];
  flavorText: string;
  recipe: Recipe;
}
