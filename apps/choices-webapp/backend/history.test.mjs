import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLabel,
  applyGameToHistory,
  anonRecord,
  HIST_CAP,
} from "./history.mjs";

const summary = (choices, winnerIndex, completedAt = 1751900000000) => ({
  choices,
  winnerLabel: choices[winnerIndex],
  completedAt,
});

test("normalizeLabel lowercases, trims, and collapses whitespace", () => {
  assert.equal(normalizeLabel("  Pizza   Place "), "pizza place");
  assert.equal(normalizeLabel("TACOS"), "tacos");
});

test("normalizeLabel strips control and zero-width characters", () => {
  assert.equal(normalizeLabel("Pizza\u200b"), "pizza");
  assert.equal(normalizeLabel("\ufeffRamen\u200d"), "ramen");
  assert.equal(normalizeLabel("\u0007 \u0007"), "");
});

test("applyGameToHistory counts entries and winners", () => {
  const hist = { entries: {} };
  const next = applyGameToHistory(
    hist,
    summary(["Pizza", "Tacos", "Sushi", "Ramen"], 3),
    1000
  );
  assert.equal(Object.keys(next.entries).length, 4);
  assert.deepEqual(next.entries.ramen, {
    label: "Ramen",
    entryCount: 1,
    winCount: 1,
    lastAt: 1000,
  });
  assert.equal(next.entries.pizza.winCount, 0);
  assert.equal(next.entries.pizza.entryCount, 1);
  assert.equal(next.updatedAt, 1000);
  assert.deepEqual(hist.entries, {}); // input untouched
});

test("applyGameToHistory accumulates across games and keeps first label casing", () => {
  let hist = { entries: {} };
  hist = applyGameToHistory(hist, summary(["Pizza", "Tacos", "Sushi", "Ramen"], 0), 1000);
  hist = applyGameToHistory(hist, summary(["PIZZA", "Burgers", "Pho", "Wings"], 1), 2000);
  assert.equal(hist.entries.pizza.entryCount, 2);
  assert.equal(hist.entries.pizza.winCount, 1);
  assert.equal(hist.entries.pizza.label, "Pizza");
  assert.equal(hist.entries.pizza.lastAt, 2000);
  assert.equal(hist.entries.burgers.winCount, 1);
});

test("applyGameToHistory evicts the least recently seen past the cap", () => {
  const entries = {};
  for (let i = 0; i < HIST_CAP; i++) {
    entries[`food-${i}`] = { label: `food-${i}`, entryCount: 1, winCount: 0, lastAt: i };
  }
  const next = applyGameToHistory(
    { entries },
    summary(["New A", "New B", "New C", "New D"], 0),
    999999
  );
  assert.equal(Object.keys(next.entries).length, HIST_CAP);
  assert.ok(next.entries["new a"]);
  assert.equal(next.entries["food-0"], undefined); // oldest evicted
  assert.equal(next.entries["food-3"], undefined);
  assert.ok(next.entries["food-4"]);
});

test("anonRecord holds only day, normalized texts, and the pairHash", () => {
  const rec = anonRecord(
    summary(["Pizza  Hut", "Tacos", "Sushi", "Ramen"], 3, Date.UTC(2026, 6, 7, 23, 59)),
    "abc123def456abcd"
  );
  assert.deepEqual(rec, {
    day: "2026-07-07",
    choices: ["pizza hut", "tacos", "sushi", "ramen"],
    winner: "ramen",
    pairHash: "abc123def456abcd",
  });
  assert.equal(rec.pairingId, undefined);
  assert.equal(rec.completedAt, undefined);
});
