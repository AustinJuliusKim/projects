import test from "node:test";
import assert from "node:assert/strict";

import { PALETTE, SPRITES } from "../src/sprites/data.ts";
import { INGREDIENTS } from "../src/game/ingredients.ts";
import { DISHES } from "../src/game/combos.ts";

test("every sprite is a 16x16 grid of palette characters", () => {
  for (const [name, rows] of Object.entries(SPRITES)) {
    assert.equal(rows.length, 16, `${name} has ${rows.length} rows`);
    rows.forEach((row, y) => {
      assert.equal(row.length, 16, `${name} row ${y} is ${row.length} chars: "${row}"`);
      for (const ch of row) {
        assert.ok(
          ch === "." || PALETTE[ch],
          `${name} row ${y} uses unknown palette char "${ch}"`,
        );
      }
    });
  }
});

test("every ingredient has a sprite", () => {
  for (const ingredient of INGREDIENTS) {
    assert.ok(SPRITES[ingredient.id], `missing sprite for ingredient ${ingredient.id}`);
  }
});

test("every dish (and the mystery stew) has a sprite", () => {
  for (const dish of DISHES) {
    assert.ok(SPRITES[dish.id], `missing sprite for dish ${dish.id}`);
  }
  assert.ok(SPRITES["mystery-stew"], "missing sprite for mystery-stew");
});

test("effect and UI sprites exist", () => {
  for (const name of ["pot", "cloud", "puff", "bang", "spoon", "star", "jar", "honey", "salt", "book", "question"]) {
    assert.ok(SPRITES[name], `missing sprite ${name}`);
  }
});
