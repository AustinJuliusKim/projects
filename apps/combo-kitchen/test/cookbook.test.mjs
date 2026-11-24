import test from "node:test";
import assert from "node:assert/strict";

import { DISHES } from "../src/game/combos.ts";
import {
  emptyCookbook,
  parseCookbook,
  serializeCookbook,
  recordDiscovery,
  discoveredDishes,
} from "../src/game/cookbook.ts";

const carbonara = DISHES.find((d) => d.id === "carbonara");

test("parseCookbook tolerates null, garbage, and wrong versions", () => {
  assert.deepEqual(parseCookbook(null), emptyCookbook());
  assert.deepEqual(parseCookbook("not json {"), emptyCookbook());
  assert.deepEqual(parseCookbook(JSON.stringify({ version: 99, discovered: {} })), emptyCookbook());
  assert.deepEqual(parseCookbook(JSON.stringify([1, 2, 3])), emptyCookbook());
});

test("recordDiscovery marks first cook as new, repeats as not", () => {
  const start = emptyCookbook();
  const first = recordDiscovery(start, carbonara, new Date("2026-01-01T00:00:00Z"));
  assert.equal(first.isNew, true);
  assert.ok(first.state.discovered.carbonara);
  const again = recordDiscovery(first.state, carbonara);
  assert.equal(again.isNew, false);
  assert.equal(again.state, first.state);
  // original state untouched
  assert.deepEqual(start, emptyCookbook());
});

test("serialize/parse round-trips", () => {
  const { state } = recordDiscovery(emptyCookbook(), carbonara, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(parseCookbook(serializeCookbook(state)), state);
});

test("discoveredDishes returns dishes and drops unknown ids", () => {
  const { state } = recordDiscovery(emptyCookbook(), carbonara);
  const withGhost = {
    version: 1,
    discovered: { ...state.discovered, "deleted-dish": { firstCookedAt: "2026-01-01T00:00:00Z" } },
  };
  const dishes = discoveredDishes(withGhost);
  assert.deepEqual(dishes.map((d) => d.id), ["carbonara"]);
});
