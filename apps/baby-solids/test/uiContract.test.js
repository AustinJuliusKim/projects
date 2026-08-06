/**
 * The views read fields off compiled food records directly. A build can
 * succeed and a screen can still crash on `undefined.map`, so this asserts
 * the contract the UI actually depends on — cheaper than a browser, and it
 * catches the realistic failure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { foods, index } = JSON.parse(
  readFileSync(new URL("../src/generated/foods.json", import.meta.url), "utf8"),
);

test("the compiled canon is non-empty and indexed", () => {
  assert.ok(foods.length > 0);
  assert.equal(index.entries.length, foods.length);
});

for (const food of foods) {
  test(`${food.id} carries every field the views read`, () => {
    // BrowseView
    assert.equal(typeof food.name, "string");
    assert.equal(typeof food.category, "string");
    assert.equal(typeof food.firstOkMonths, "number");
    assert.ok(Array.isArray(food.allergens), "BrowseView calls .length on allergens");
    assert.ok(food.nutrients && typeof food.nutrients.ironType === "string");
    assert.ok(food.choking && typeof food.choking.level === "string");

    // FoodView
    assert.ok(Array.isArray(food.aliases), "FoodView calls .join on aliases");
    assert.ok(Array.isArray(food.ageBands) && food.ageBands.length > 0);
    for (const band of food.ageBands) {
      assert.equal(typeof band.band, "string");
      assert.equal(typeof band.geometry, "string");
      assert.equal(typeof band.prepMd, "string", "every band renders its prep prose");
    }
    assert.ok(Array.isArray(food.sources) && food.sources.length > 0);
    for (const src of food.sources) {
      assert.equal(typeof src.url, "string");
      assert.equal(typeof src.body, "string");
      assert.equal(typeof src.tier, "string");
      assert.equal(typeof src.retrieved, "string");
    }
    assert.ok(Array.isArray(food.relatedIds));

    // An allergen protocol must always carry its gate — the view renders it
    // as the first thing on the page, and an empty alert would be worse than
    // no alert.
    if (food.allergenProtocol) {
      assert.ok(
        food.allergenProtocol.medicalGate?.length > 0,
        "allergenProtocol without a medicalGate would render an empty warning",
      );
    }
  });
}

test("every relatedId resolves to a real food (no dead links in the UI)", () => {
  const ids = new Set(foods.map((f) => f.id));
  for (const food of foods) {
    for (const rel of food.relatedIds) {
      assert.ok(ids.has(rel), `${food.id} links to missing ${rel}`);
    }
  }
});

test("the tier badge map covers every tier used in the canon", () => {
  // FoodView falls back to a grey "Source" badge, but an unmapped tier means
  // the evidence grading silently stops being visible.
  const known = new Set(["guideline", "trial", "expert_opinion", "common_practice"]);
  for (const food of foods) {
    for (const src of food.sources) {
      assert.ok(known.has(src.tier), `${food.id} uses unmapped tier "${src.tier}"`);
    }
  }
});
