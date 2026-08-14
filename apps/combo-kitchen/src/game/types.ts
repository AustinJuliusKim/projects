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
  emoji: string;
}

export interface Recipe {
  ingredients: string[];
  steps: string[];
}

export interface Dish {
  id: string;
  name: string;
  plateEmoji: string;
  combo: [IngredientId, IngredientId, IngredientId];
  flavorText: string;
  recipe: Recipe;
}
