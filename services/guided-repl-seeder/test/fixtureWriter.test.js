import test from "node:test";
import assert from "node:assert/strict";

import { buildFixture } from "../src/fixtureWriter.js";

const base = {
  lessonId: "l1",
  branchId: "vague",
  claudeCodeVersion: "2.1.198",
  seedSnapshotId: "l1-input",
  permissionMode: "acceptEdits",
  expectedPrompt: "make a page",
  events: [{ frame: { type: "done" }, delayMs: 0 }],
  assertion: { type: "file-exists", path: "index.html" },
};

test("buildFixture stamps kind claudeStream by default", () => {
  const fixture = buildFixture(base);
  assert.equal(fixture.kind, "claudeStream");
  assert.equal(fixture.fixtureVersion, 1);
});

test("buildFixture honors an explicit kind override", () => {
  const fixture = buildFixture({ ...base, kind: "shellTranscript" });
  assert.equal(fixture.kind, "shellTranscript");
});
