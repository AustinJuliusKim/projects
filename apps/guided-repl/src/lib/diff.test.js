import { test } from "node:test";
import assert from "node:assert/strict";
import { diff } from "./diff.js";

test("diff reports all-same for identical content", () => {
  const result = diff("a\nb\nc", "a\nb\nc");
  assert.deepEqual(result, [
    { type: "same", line: "a" },
    { type: "same", line: "b" },
    { type: "same", line: "c" },
  ]);
});

test("diff reports adds for new content from empty", () => {
  const result = diff("", "a\nb");
  assert.deepEqual(result, [
    { type: "del", line: "" },
    { type: "add", line: "a" },
    { type: "add", line: "b" },
  ]);
});

test("diff reports a mix of same/add/del for a modified line", () => {
  const result = diff("a\nb\nc", "a\nx\nc");
  assert.deepEqual(result, [
    { type: "same", line: "a" },
    { type: "del", line: "b" },
    { type: "add", line: "x" },
    { type: "same", line: "c" },
  ]);
});
