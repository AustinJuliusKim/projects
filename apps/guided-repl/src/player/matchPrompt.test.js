import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPrompt } from "./matchPrompt.js";

const branches = [
  { branchId: "vague", expectedPrompt: "make a page about me" },
  { branchId: "constrained", expectedPrompt: "make a personal landing page about me, single HTML file, inline CSS" },
];

test("matchPrompt exact match returns the branchId", () => {
  assert.deepEqual(matchPrompt("make a page about me", branches), { branchId: "vague" });
});

test("matchPrompt matches after trim + whitespace collapse", () => {
  assert.deepEqual(matchPrompt("  make   a page about me  ", branches), { branchId: "vague" });
});

test("matchPrompt returns null on no match", () => {
  assert.equal(matchPrompt("make a completely different thing", branches), null);
});
