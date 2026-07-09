import test from "node:test";
import assert from "node:assert/strict";

import { resolveAnchor } from "../anchors.js";

const events = [
  { frame: { type: "session_ready" }, delayMs: 0 },
  { frame: { type: "text", payload: { delta: "I'll edit" } }, delayMs: 10 },
  { frame: { type: "tool_use", payload: { id: "t1", tool: "Write", input: { file_path: "index.html", content: "" } } }, delayMs: 10 },
  { awaitClient: "permission", choices: ["approve", "deny"] },
  { frame: { type: "tool_use", payload: { id: "t2", tool: "Edit", input: { file_path: "index.html" } } }, delayMs: 10 },
  { frame: { type: "tool_use", payload: { id: "t3", tool: "Edit", input: { file_path: "styles.css" } } }, delayMs: 10 },
  { frame: { type: "done" }, delayMs: 0 },
];

test("resolves the first frame of a type", () => {
  assert.equal(resolveAnchor({ ordinal: 1, frameType: "text" }, events), 1);
});

test("resolves by ordinal", () => {
  assert.equal(resolveAnchor({ ordinal: 2, frameType: "tool_use" }, events), 4);
});

test("narrows by tool", () => {
  assert.equal(resolveAnchor({ ordinal: 1, frameType: "tool_use", where: { tool: "Edit" } }, events), 4);
});

test("narrows by pathIncludes", () => {
  assert.equal(
    resolveAnchor({ ordinal: 1, frameType: "tool_use", where: { tool: "Edit", pathIncludes: "styles" } }, events),
    5,
  );
});

test("skips awaitClient markers", () => {
  // The marker at index 3 is not a frame event and must not count.
  assert.equal(resolveAnchor({ ordinal: 3, frameType: "tool_use" }, events), 5);
});

test("returns null when the ordinal overshoots", () => {
  assert.equal(resolveAnchor({ ordinal: 4, frameType: "tool_use" }, events), null);
});

test("returns null when nothing matches", () => {
  assert.equal(resolveAnchor({ ordinal: 1, frameType: "tool_use", where: { tool: "Bash" } }, events), null);
});
