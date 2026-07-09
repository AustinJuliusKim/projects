import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileLesson, compileAll } from "../src/compile.js";

/** Builds a scratch fixtures root with one claudeStream fixture + snapshot. */
function makeFixturesRoot() {
  const root = mkdtempSync(join(tmpdir(), "lessons-test-"));
  mkdirSync(join(root, "fixtures/l1"), { recursive: true });
  mkdirSync(join(root, "snapshots"), { recursive: true });
  const fixture = {
    fixtureVersion: 1,
    claudeCodeVersion: "2.1.198",
    lessonId: "l1",
    branchId: "constrained",
    recordedAt: "2026-07-02T00:00:00Z",
    seedSnapshotId: "l1-input",
    permissionMode: "acceptEdits",
    expectedPrompt: "make a page",
    events: [
      { frame: { type: "session_ready" }, delayMs: 0 },
      { frame: { type: "tool_use", payload: { id: "t1", tool: "Write", input: { file_path: "index.html", content: "" } } }, delayMs: 10 },
      { frame: { type: "done" }, delayMs: 0 },
    ],
    assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
  };
  writeFileSync(join(root, "fixtures/l1/constrained.json"), JSON.stringify(fixture));
  writeFileSync(
    join(root, "snapshots/l1-input.json"),
    JSON.stringify({ snapshotId: "l1-input", files: [{ path: "README.md", content: "seed" }] }),
  );
  return root;
}

function makeDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "l1",
    slug: "ship-a-page",
    title: "Ship a page",
    track: "guided",
    order: 1,
    durationTargetSec: 300,
    prereqs: [],
    snapshot: { snapshotId: "l1-input" },
    fixtures: { constrained: { path: "fixtures/l1/constrained.json", kind: "claudeStream" } },
    steps: [
      { type: "instruction", id: "intro", md: "Go." },
      { type: "promptBuilder", id: "compose", suggestions: [{ text: "make a page", branchId: "constrained" }] },
      {
        type: "run",
        id: "run",
        branches: { constrained: { fixture: "constrained", expectedPrompt: "make a page", permissionMode: "acceptEdits" } },
      },
      { type: "assertion", id: "grade", rule: { type: "file-contains", path: "index.html", match: "<h1>" } },
    ],
    completion: { assertionIds: ["grade"], next: null },
    ...overrides,
  };
}

test("compileLesson passes a well-formed lesson and stamps nothing extra", () => {
  const root = makeFixturesRoot();
  const compiled = compileLesson(makeDoc(), root);
  assert.equal(compiled.id, "l1");
});

test("compileLesson stamps resolvedEventIndex for annotation anchors", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc();
  doc.steps.splice(3, 0, {
    type: "annotation",
    id: "note",
    fixtureKey: "constrained",
    anchor: { ordinal: 1, frameType: "tool_use", where: { tool: "Write" } },
    md: "The write.",
  });
  const compiled = compileLesson(doc, root);
  const annotation = compiled.steps.find((s) => s.type === "annotation");
  assert.equal(annotation.resolvedEventIndex, 1);
});

test("compileLesson fails when an anchor does not resolve", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc();
  doc.steps.splice(3, 0, {
    type: "annotation",
    id: "note",
    fixtureKey: "constrained",
    anchor: { ordinal: 2, frameType: "tool_use", where: { tool: "Write" } },
    md: "No second write exists.",
  });
  assert.throws(() => compileLesson(doc, root), /anchor did not resolve/);
});

test("compileLesson fails on a missing fixture file", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc({ fixtures: { constrained: { path: "fixtures/l1/nope.json", kind: "claudeStream" } } });
  assert.throws(() => compileLesson(doc, root), /file not found/);
});

test("compileLesson fails when envelope fields disagree with the fixture", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc();
  doc.steps[2].branches.constrained.permissionMode = "plan";
  doc.steps[1].suggestions[0].text = "make a page";
  assert.throws(() => compileLesson(doc, root), /permissionMode/);
});

test("compileLesson fails when a suggestion matches no branch", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc();
  doc.steps[1].suggestions = [{ text: "do something else" }];
  assert.throws(() => compileLesson(doc, root), /matches no branch/);
});

test("compileLesson fails when a suggestion's branchId text mismatches", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc();
  doc.steps[1].suggestions = [{ text: "wrong text", branchId: "constrained" }];
  assert.throws(() => compileLesson(doc, root), /does not match branch/);
});

/** Adds a second branch fixture (own branchId/prompt) to a fixtures root. */
function addBranchFixture(root, branchId, expectedPrompt) {
  const base = JSON.parse(readFileSync(join(root, "fixtures/l1/constrained.json"), "utf8"));
  writeFileSync(
    join(root, `fixtures/l1/${branchId}.json`),
    JSON.stringify({ ...base, branchId, expectedPrompt }),
  );
}

test("compileLesson fails when a branch is unreachable", () => {
  const root = makeFixturesRoot();
  addBranchFixture(root, "ghost", "unreachable");
  const doc = makeDoc();
  doc.fixtures.ghost = { path: "fixtures/l1/ghost.json", kind: "claudeStream" };
  doc.steps[2].branches.ghost = { fixture: "ghost", expectedPrompt: "unreachable", permissionMode: "acceptEdits" };
  assert.throws(() => compileLesson(doc, root), /not reachable by any suggestion/);
});

test("compileLesson fails on ambiguous suggestion without branchId", () => {
  const root = makeFixturesRoot();
  // Same expectedPrompt on a second branch — the l4/l5/l7/l8 shape.
  addBranchFixture(root, "twin", "make a page");
  const doc = makeDoc();
  doc.fixtures.twin = { path: "fixtures/l1/twin.json", kind: "claudeStream" };
  doc.steps[2].branches.twin = { fixture: "twin", expectedPrompt: "make a page", permissionMode: "acceptEdits" };
  doc.steps[1].suggestions = [{ text: "make a page" }];
  assert.throws(() => compileLesson(doc, root), /ambiguous/);
});

test("compileLesson enforces slot cross-product resolution", () => {
  const root = makeFixturesRoot();
  const doc = makeDoc();
  doc.steps[1].slots = [
    { name: "task", choices: ["make a"] },
    { name: "thing", choices: ["page", "poster"] },
  ];
  // "make a poster" resolves to no branch.
  assert.throws(() => compileLesson(doc, root), /slot combination/);
});

test("compileAll compiles the real committed spine", () => {
  // Uses the package's actual lessons/ + the app's committed fixtures.
  const manifest = compileAll();
  assert.equal(manifest.lessons.length, 8);
  assert.deepEqual(
    manifest.lessons.map((l) => l.id),
    ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"],
  );
  const l1 = manifest.lessons[0];
  const annotation = l1.steps.find((s) => s.type === "annotation");
  assert.ok(Number.isInteger(annotation.resolvedEventIndex));
});
