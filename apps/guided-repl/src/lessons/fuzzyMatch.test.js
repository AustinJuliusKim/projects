import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSuggestion, filterSuggestions } from "./fuzzyMatch.js";

test("scoreSuggestion: prefix beats subsequence beats none", () => {
  assert.equal(scoreSuggestion("make a", "make a page about me"), 2);
  assert.equal(scoreSuggestion("mkpage", "make a page"), 1);
  assert.equal(scoreSuggestion("zzz", "make a page"), 0);
});

test("scoreSuggestion: empty input matches everything as prefix", () => {
  assert.equal(scoreSuggestion("", "anything"), 2);
  assert.equal(scoreSuggestion("   ", "anything"), 2);
});

test("scoreSuggestion is case- and whitespace-insensitive", () => {
  assert.equal(scoreSuggestion("MAKE  A", "make a page"), 2);
});

test("filterSuggestions ranks prefix matches first, keeps authored order within bands", () => {
  const suggestions = [
    { text: "restyle the page with a dark theme" },
    { text: "make a page about me" },
    { text: "make a personal landing page" },
  ];
  const filtered = filterSuggestions("make", suggestions);
  assert.deepEqual(
    filtered.map((s) => s.text),
    ["make a page about me", "make a personal landing page"],
  );
});

test("filterSuggestions keeps subsequence matches after prefix matches", () => {
  const suggestions = [{ text: "git status" }, { text: "great insight" }];
  const filtered = filterSuggestions("gs", suggestions);
  // "gs" is a subsequence of both; neither is a prefix — authored order holds.
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].text, "git status");
});
