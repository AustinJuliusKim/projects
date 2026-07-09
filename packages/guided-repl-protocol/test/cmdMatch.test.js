import test from "node:test";
import assert from "node:assert/strict";

import { matchCommand } from "../cmdMatch.js";

test("exact matcher normalizes whitespace", () => {
  assert.ok(matchCommand({ kind: "exact", value: "git diff" }, "  git   diff "));
  assert.ok(!matchCommand({ kind: "exact", value: "git diff" }, "git diff --stat"));
});

test("regex matcher tests the trimmed input", () => {
  assert.ok(matchCommand({ kind: "regex", value: "^git (diff|status)$" }, " git status "));
  assert.ok(!matchCommand({ kind: "regex", value: "^git (diff|status)$" }, "git push"));
});
