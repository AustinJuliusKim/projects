import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, parseFour } from "./suggestai.mjs";

test("buildPrompt includes the occasion and win-flagged history", () => {
  const prompt = buildPrompt({
    occasion: "Date night",
    historyEntries: [
      { label: "Ramen", entryCount: 3, winCount: 2, lastAt: 2000 },
      { label: "Pizza", entryCount: 1, winCount: 0, lastAt: 1000 },
    ],
  });
  assert.ok(prompt.includes("Occasion: Date night"));
  assert.ok(prompt.includes("- Ramen (won 2x)"));
  assert.ok(prompt.includes("- Pizza"));
  assert.ok(!prompt.includes("Pizza (won"));
});

test("buildPrompt without history stays occasion-only", () => {
  const prompt = buildPrompt({ occasion: "Quick bite" });
  assert.ok(prompt.includes("Occasion: Quick bite"));
  assert.ok(!prompt.includes("played before"));
  assert.ok(!prompt.includes("They're near"));
});

test("buildPrompt adds the city hint only when a city is present", () => {
  const withPlace = buildPrompt({
    occasion: "Date night",
    place: { city: "Portland", country: "US" },
  });
  assert.ok(withPlace.includes("They're near Portland, US"));
  const cityOnly = buildPrompt({ place: { city: "Portland", country: null } });
  assert.ok(cityOnly.includes("They're near Portland —"));
  const noCity = buildPrompt({ place: { city: null, country: "US" } });
  assert.ok(!noCity.includes("They're near"));
});

test("buildPrompt caps history at the 12 strongest entries", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    label: `Food ${i}`,
    entryCount: 1,
    winCount: i, // strongest last
    lastAt: i,
  }));
  const prompt = buildPrompt({ historyEntries: entries });
  assert.ok(prompt.includes("- Food 29"));
  assert.ok(!prompt.includes("- Food 5\n"));
});

test("parseFour accepts a clean array and trims/caps entries", () => {
  assert.deepEqual(parseFour('["Pizza", " Tacos ", "Sushi", "Ramen"]'), [
    "Pizza",
    "Tacos",
    "Sushi",
    "Ramen",
  ]);
  const long = parseFour(`["${"x".repeat(80)}", "b", "c", "d"]`);
  assert.equal(long[0].length, 60);
});

test("parseFour tolerates fences and prose around the array", () => {
  const reply =
    'Here you go!\n```json\n["Pizza", "Tacos", "Sushi", "Ramen"]\n```\nEnjoy!';
  assert.deepEqual(parseFour(reply), ["Pizza", "Tacos", "Sushi", "Ramen"]);
});

test("parseFour rejects wrong sizes, empties, and non-arrays", () => {
  assert.equal(parseFour('["a", "b", "c"]'), null);
  assert.equal(parseFour('["a", "b", "c", "d", "e"]'), null);
  assert.equal(parseFour('["a", "b", "c", ""]'), null);
  assert.equal(parseFour('["a", "b", "c", 4]'), null);
  assert.equal(parseFour("no array here"), null);
  assert.equal(parseFour(null), null);
});
