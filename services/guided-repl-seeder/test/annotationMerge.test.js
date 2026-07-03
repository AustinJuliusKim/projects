import test from "node:test";
import assert from "node:assert/strict";

import { mergeAnnotations } from "../src/annotationMerge.js";

const sourceFixture = {
  fixtureVersion: 1,
  claudeCodeVersion: "2.1.198 (Claude Code)",
  lessonId: "l1",
  branchId: "constrained",
  recordedAt: "2026-07-02T19:11:28.216Z",
  seedSnapshotId: "l1-input",
  permissionMode: "acceptEdits",
  expectedPrompt: "make a personal landing page about me, single index.html file, inline CSS",
  events: [
    { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
    { frame: { type: "text", payload: { delta: "hi" } }, delayMs: 10, origDelayMs: 10 },
    {
      frame: { type: "tool_use", payload: { id: "1", tool: "Write", input: { file_path: "index.html", content: "x" } } },
      delayMs: 10,
      origDelayMs: 10,
    },
    { frame: { type: "usage", payload: { inputTokens: 1, outputTokens: 1 } }, delayMs: 0, origDelayMs: 0 },
    { frame: { type: "done" }, delayMs: 0, origDelayMs: 0 },
  ],
  assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
};

test("rewrites lessonId and branchId", () => {
  const out = mergeAnnotations(sourceFixture, {
    lessonId: "l2",
    branchId: "walkthrough",
    annotations: [],
  });
  assert.equal(out.lessonId, "l2");
  assert.equal(out.branchId, "walkthrough");
});

test("attaches annotations at the given indices, leaving other events untouched", () => {
  const out = mergeAnnotations(sourceFixture, {
    lessonId: "l2",
    branchId: "walkthrough",
    annotations: [
      { index: 1, annotation: { title: "Explore", body: "..." } },
      { index: 2, annotation: { title: "Write", body: "..." } },
    ],
  });
  assert.deepEqual(out.events[1].annotation, { title: "Explore", body: "..." });
  assert.deepEqual(out.events[2].annotation, { title: "Write", body: "..." });
  assert.equal("annotation" in out.events[0], false);
  assert.equal("annotation" in out.events[3], false);
});

test("does not mutate the source fixture", () => {
  mergeAnnotations(sourceFixture, {
    lessonId: "l2",
    branchId: "walkthrough",
    annotations: [{ index: 1, annotation: { title: "Explore", body: "..." } }],
  });
  assert.equal("annotation" in sourceFixture.events[1], false);
});

test("throws on an out-of-range index", () => {
  assert.throws(() =>
    mergeAnnotations(sourceFixture, { lessonId: "l2", branchId: "walkthrough", annotations: [{ index: 99, annotation: { title: "x", body: "y" } }] })
  );
});

test("throws when targeting an awaitClient marker", () => {
  const withGate = {
    ...sourceFixture,
    events: [...sourceFixture.events, { awaitClient: "permission", choices: ["approve", "deny"] }],
  };
  assert.throws(() =>
    mergeAnnotations(withGate, { lessonId: "l2", branchId: "walkthrough", annotations: [{ index: 5, annotation: { title: "x", body: "y" } }] })
  );
});

test("the merged fixture validates", () => {
  const out = mergeAnnotations(sourceFixture, {
    lessonId: "l2",
    branchId: "walkthrough",
    annotations: [{ index: 1, annotation: { title: "Explore", body: "..." } }],
  });
  assert.equal(out.fixtureVersion, 1);
});
