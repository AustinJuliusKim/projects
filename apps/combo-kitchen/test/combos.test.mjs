import test from "node:test";
import assert from "node:assert/strict";

import { DISHES } from "../src/game/combos.ts";
import { INGREDIENTS } from "../src/game/ingredients.ts";
import { comboKey } from "../src/game/logic.ts";

const ingredientIds = new Set(INGREDIENTS.map((i) => i.id));

test("there are at least 20 dishes", () => {
  assert.ok(DISHES.length >= 20, `only ${DISHES.length} dishes`);
});

test("dish ids are unique", () => {
  const ids = DISHES.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("combo keys are unique", () => {
  const keys = DISHES.map((d) => comboKey(d.combo));
  assert.equal(new Set(keys).size, keys.length);
});

test("every combo ingredient exists in the pantry", () => {
  for (const dish of DISHES) {
    for (const id of dish.combo) {
      assert.ok(ingredientIds.has(id), `${dish.name} uses unknown ingredient ${id}`);
    }
  }
});

test("every recipe has 4-6 steps and at least 3 ingredient lines", () => {
  for (const dish of DISHES) {
    assert.ok(
      dish.recipe.steps.length >= 4 && dish.recipe.steps.length <= 6,
      `${dish.name} has ${dish.recipe.steps.length} steps`,
    );
    assert.ok(
      dish.recipe.ingredients.length >= 3,
      `${dish.name} has ${dish.recipe.ingredients.length} ingredient lines`,
    );
  }
});

test("required seed combos are present", () => {
  const byKey = new Map(DISHES.map((d) => [comboKey(d.combo), d.name]));
  assert.equal(byKey.get(comboKey(["cheese", "bacon", "pasta"])), "Carbonara Pasta");
  assert.equal(byKey.get(comboKey(["meat", "potato", "flour"])), "Meat Pot Pie");
  assert.equal(byKey.get(comboKey(["chicken", "rice", "egg"])), "Oyakodon Bowl");
  assert.equal(byKey.get(comboKey(["rice", "meat", "egg"])), "Loco Moco");
});

test("every ingredient appears in at least 2 dishes", () => {
  const counts = new Map();
  for (const dish of DISHES) {
    for (const id of dish.combo) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of ingredientIds) {
    assert.ok((counts.get(id) ?? 0) >= 2, `${id} appears in ${counts.get(id) ?? 0} dishes`);
  }
});
