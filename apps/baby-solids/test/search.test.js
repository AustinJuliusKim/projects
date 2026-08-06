/**
 * Search regression table.
 *
 * The named case here is `"sal"` → salmon. A widely-used competitor's app
 * returns "yam" for that query, which is what edit-distance ranking does to
 * short inputs: at distance 1-2 a three-letter query matches almost anything,
 * and the real prefix match loses to a shorter word. Prefix-first tiering is
 * the fix, and this table is what keeps it fixed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchIndex } from "../scripts/searchIndex.js";
import { searchFoods } from "../src/search.js";

const FOODS = [
  { id: "salmon", name: "Salmon", aliases: ["yeoneo", "연어"], category: "animal_protein" },
  { id: "yam", name: "Yam", aliases: [], category: "vegetable" },
  { id: "sweet-potato", name: "Sweet potato", aliases: ["goguma", "고구마", "kumara"], category: "vegetable" },
  { id: "kabocha", name: "Kabocha squash", aliases: ["danhobak", "단호박"], category: "vegetable" },
  { id: "peanut", name: "Peanut", aliases: ["peanut butter", "ttangkong", "땅콩"], category: "plant_protein" },
  { id: "pear", name: "Pear", aliases: ["bae", "배"], category: "fruit" },
  { id: "peas", name: "Peas", aliases: [], category: "vegetable" },
  { id: "black-beans", name: "Black beans", aliases: [], category: "plant_protein" },
  { id: "beef", name: "Beef", aliases: ["sogogi", "소고기"], category: "animal_protein" },
  { id: "egg", name: "Egg", aliases: [], category: "animal_protein" },
];

const index = buildSearchIndex(FOODS);
const top = (q) => searchFoods(index, q)[0];
const all = (q) => searchFoods(index, q);

/** @type {[string, string, string][]} query, expected top id, why */
const CASES = [
  ["sal", "salmon", "the canonical bug: must NOT return yam"],
  ["salm", "salmon", "longer prefix, same answer"],
  ["salmon", "salmon", "exact name"],
  ["Salmon", "salmon", "case-insensitive"],
  ["  salmon  ", "salmon", "whitespace-trimmed"],
  ["yam", "yam", "exact name still wins for its own query"],
  ["ya", "yam", "prefix of yam"],
  ["sweet", "sweet-potato", "name prefix, multi-word name"],
  ["potato", "sweet-potato", "token prefix inside a multi-word name"],
  ["gog", "sweet-potato", "romanized alias prefix"],
  ["고구", "sweet-potato", "Korean alias prefix — codepoint-safe, no ASCII assumption"],
  ["고구마", "sweet-potato", "Korean alias exact"],
  ["단호박", "kabocha", "Korean alias exact, different food"],
  ["danho", "kabocha", "romanized Korean prefix"],
  // "pea" prefixes Pear, Peas and Peanut. Pear and Peas tie at four
  // characters, so the alphabetical id tiebreak settles it. The point of the
  // case is that the answer is *stable*, not that it's any particular food.
  ["pea", "pear", "ambiguous prefix resolves deterministically by length then id"],
  ["pean", "peanut", "one more character disambiguates to peanut"],
  ["peanut butter", "peanut", "multi-word alias exact"],
  ["소고기", "beef", "Korean alias for an iron-rich first food"],
  ["black", "black-beans", "prefix on a hyphenated id"],
  ["egg", "egg", "short exact name"],
];

for (const [query, expected, why] of CASES) {
  test(`search "${query}" → ${expected} (${why})`, () => {
    assert.equal(top(query), expected);
  });
}

test("an empty query returns nothing rather than everything", () => {
  assert.deepEqual(all(""), []);
  assert.deepEqual(all("   "), []);
});

test("a query with no match returns nothing — no fuzzy fallback", () => {
  // With edit-distance scoring this would return something plausible-looking.
  // Returning nothing is the correct, honest answer.
  assert.deepEqual(all("zzzzz"), []);
});

test("prefix hits are never diluted by weaker substring hits", () => {
  // "ea" is a substring of peanut/peas/beef/pear but a prefix of none, so the
  // matcher falls to the substring tier only after the prefix tiers are empty.
  const results = all("pea");
  assert.ok(results.includes("peas") && results.includes("peanut"));
  assert.ok(!results.includes("beef"), "beef only matches 'ea' as a substring");
});

test("results are deterministic across repeated calls", () => {
  assert.deepEqual(all("pea"), all("pea"));
});
