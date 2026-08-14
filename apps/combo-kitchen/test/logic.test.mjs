import test from "node:test";
import assert from "node:assert/strict";

import { DISHES } from "../src/game/combos.ts";
import { comboKey, findDish, mysteryDish, cook } from "../src/game/logic.ts";

test("comboKey sorts and joins", () => {
  assert.equal(comboKey(["pasta", "cheese", "bacon"]), "bacon+cheese+pasta");
  assert.equal(comboKey(["bacon", "cheese", "pasta"]), "bacon+cheese+pasta");
});

test("comboKey rejects wrong lengths and duplicates", () => {
  assert.throws(() => comboKey(["egg", "rice"]));
  assert.throws(() => comboKey(["egg", "rice", "milk", "flour"]));
  assert.throws(() => comboKey(["egg", "egg", "rice"]));
});

test("findDish is order-insensitive", () => {
  const a = findDish(["cheese", "bacon", "pasta"]);
  const b = findDish(["pasta", "cheese", "bacon"]);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(a.name, "Carbonara Pasta");
});

test("every dish round-trips through findDish", () => {
  for (const dish of DISHES) {
    assert.equal(findDish(dish.combo), dish);
  }
});

test("unknown trio cooks a mystery", () => {
  const { dish, isMystery } = cook(["chocolate", "fish", "bacon"], () => 0);
  assert.equal(isMystery, true);
  assert.equal(dish.name, "Mystery Stew");
  assert.ok(dish.recipe.steps.length >= 4);
});

test("known trio cooks the real dish", () => {
  const { dish, isMystery } = cook(["egg", "flour", "milk"]);
  assert.equal(isMystery, false);
  assert.equal(dish.name, "Fluffy Pancakes");
});

test("mysteryDish is deterministic under a stubbed rng", () => {
  const a = mysteryDish(["chocolate", "fish", "bacon"], () => 0.99);
  const b = mysteryDish(["fish", "bacon", "chocolate"], () => 0.99);
  assert.deepEqual(a, b);
});

test("mystery recipe mentions the picked ingredients", () => {
  const dish = mysteryDish(["chocolate", "fish", "bacon"], () => 0);
  const text = dish.recipe.ingredients.join(" ");
  assert.match(text, /chocolate/);
  assert.match(text, /fish/);
  assert.match(text, /bacon/);
});
