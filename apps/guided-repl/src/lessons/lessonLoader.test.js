import { test } from "node:test";
import assert from "node:assert/strict";
import { indexLessons } from "./lessonLoader.js";

/** Minimal schema-valid compiled lesson (the shape @guided-repl/lessons emits). */
function makeCompiledLesson(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "l1",
    slug: "ship-a-page",
    title: "Ship a page in 90 seconds",
    track: "guided",
    order: 1,
    durationTargetSec: 300,
    prereqs: [],
    snapshot: { snapshotId: "l1-input" },
    fixtures: {
      vague: { path: "fixtures/l1/vague.json", kind: "claudeStream" },
      constrained: { path: "fixtures/l1/constrained.json", kind: "claudeStream" },
    },
    steps: [
      { type: "instruction", id: "intro", md: "Go." },
      {
        type: "promptBuilder",
        id: "compose",
        suggestions: [
          { text: "make a page about me, in index.html", description: "vague", branchId: "vague" },
          { text: "make a personal landing page about me, single index.html file, inline CSS", description: "constrained", branchId: "constrained" },
        ],
      },
      {
        type: "run",
        id: "run",
        branches: {
          vague: { fixture: "vague", expectedPrompt: "make a page about me, in index.html", permissionMode: "acceptEdits" },
          constrained: {
            fixture: "constrained",
            expectedPrompt: "make a personal landing page about me, single index.html file, inline CSS",
            permissionMode: "acceptEdits",
          },
        },
      },
      { type: "assertion", id: "grade", rule: { type: "file-contains", path: "index.html", match: "<h1>" } },
    ],
    completion: { assertionIds: ["grade"], next: "l2" },
    ...overrides,
  };
}

function makeManifest(lessons) {
  return { schemaVersion: 1, lessons };
}

test("indexLessons reshapes an unlocked lesson's branches", () => {
  const [lesson] = indexLessons(makeManifest([makeCompiledLesson()]));
  assert.equal(lesson.lessonId, "l1");
  assert.equal(lesson.locked, false);
  assert.equal(lesson.seedSnapshotId, "l1-input");
  assert.deepEqual(lesson.branches, [
    {
      branchId: "vague",
      expectedPrompt: "make a page about me, in index.html",
      permissionMode: "acceptEdits",
      fixturePath: "fixtures/l1/vague.json",
      seedSnapshotId: "l1-input",
    },
    {
      branchId: "constrained",
      expectedPrompt: "make a personal landing page about me, single index.html file, inline CSS",
      permissionMode: "acceptEdits",
      fixturePath: "fixtures/l1/constrained.json",
      seedSnapshotId: "l1-input",
    },
  ]);
});

test("indexLessons carries steps, suggestions, and completion through", () => {
  const [lesson] = indexLessons(makeManifest([makeCompiledLesson()]));
  assert.equal(lesson.steps.length, 4);
  assert.equal(lesson.suggestions.length, 2);
  assert.equal(lesson.suggestions[0].branchId, "vague");
  assert.deepEqual(lesson.completion, { assertionIds: ["grade"], next: "l2" });
});

test("indexLessons returns locked lessons as stubs (lessonId/title/locked only)", () => {
  const [stub] = indexLessons(makeManifest([makeCompiledLesson({ locked: true })]));
  assert.deepEqual(stub, { lessonId: "l1", title: "Ship a page in 90 seconds", locked: true });
});

test("indexLessons honors a per-branch seedSnapshotId override", () => {
  const compiled = makeCompiledLesson();
  compiled.steps[2].branches.constrained.seedSnapshotId = "l7-input-claudemd";
  const [lesson] = indexLessons(makeManifest([compiled]));
  assert.equal(lesson.branches[0].seedSnapshotId, "l1-input");
  assert.equal(lesson.branches[1].seedSnapshotId, "l7-input-claudemd");
});

test("indexLessons maps run pacing step to playback", () => {
  const compiled = makeCompiledLesson();
  compiled.steps[2].pacing = "step";
  const [lesson] = indexLessons(makeManifest([compiled]));
  assert.equal(lesson.playback, "step");

  const [autoLesson] = indexLessons(makeManifest([makeCompiledLesson()]));
  assert.equal(autoLesson.playback, undefined);
});

test("indexLessons groups anchored annotations per matching branch", () => {
  const compiled = makeCompiledLesson();
  compiled.steps.splice(3, 0, {
    type: "annotation",
    id: "note",
    fixtureKey: "constrained",
    anchor: { ordinal: 1, frameType: "tool_use", where: { tool: "Write" } },
    md: "The write.",
    resolvedEventIndex: 4,
  });
  const [lesson] = indexLessons(makeManifest([compiled]));
  assert.deepEqual(lesson.annotationsByBranch, {
    constrained: { 4: { body: "The write." } },
  });
});

test("indexLessons appends drill transcripts as prompt-less pseudo-branches", () => {
  const compiled = makeCompiledLesson();
  compiled.fixtures.drill = { path: "fixtures/l1/drill.json", kind: "shellTranscript" };
  compiled.steps.splice(3, 0, {
    type: "terminalDrill",
    id: "try-git",
    expect: { kind: "exact", value: "git diff" },
    transcript: "drill",
  });
  const [lesson] = indexLessons(makeManifest([compiled]));
  const drill = lesson.branches.find((b) => b.branchId === "drill:try-git");
  assert.ok(drill);
  assert.equal(drill.expectedPrompt, null);
  assert.equal(drill.fixturePath, "fixtures/l1/drill.json");
  assert.equal(drill.seedSnapshotId, "l1-input");
});

test("indexLessons rejects a manifest that fails the schema", () => {
  assert.throws(() => indexLessons({ schemaVersion: 1, lessons: [{ id: "l1" }] }), /Invalid lesson/);
  assert.throws(() => indexLessons({ lessons: [] }), /Invalid lesson manifest/);
});
