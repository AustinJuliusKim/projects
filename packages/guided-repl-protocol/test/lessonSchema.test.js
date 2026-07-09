import test from "node:test";
import assert from "node:assert/strict";

import { validateLessonDoc, validateLessonManifest, LESSON_SCHEMA_VERSION } from "../lessonSchema.js";

function makeLesson(overrides = {}) {
  return {
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "l1",
    slug: "ship-a-page",
    title: "Ship a page in 90 seconds",
    track: "guided",
    order: 1,
    durationTargetSec: 300,
    prereqs: [],
    snapshot: { snapshotId: "l1-input" },
    fixtures: {
      constrained: { path: "fixtures/l1/constrained.json", kind: "claudeStream" },
    },
    steps: [
      { type: "instruction", id: "intro", md: "Welcome." },
      {
        type: "promptBuilder",
        id: "compose",
        suggestions: [{ text: "make a page", description: "the good prompt", branchId: "constrained" }],
      },
      {
        type: "run",
        id: "run",
        branches: {
          constrained: {
            fixture: "constrained",
            expectedPrompt: "make a page",
            permissionMode: "acceptEdits",
          },
        },
      },
      {
        type: "assertion",
        id: "grade",
        rule: { type: "file-contains", path: "index.html", match: "<h1>" },
      },
    ],
    completion: { assertionIds: ["grade"], next: "l2" },
    ...overrides,
  };
}

test("validateLessonDoc accepts a well-formed lesson", () => {
  const lesson = validateLessonDoc(makeLesson());
  assert.equal(lesson.id, "l1");
  assert.equal(lesson.fixtures.constrained.kind, "claudeStream");
});

test("validateLessonDoc applies fixture kind default", () => {
  const lesson = makeLesson({
    fixtures: { constrained: { path: "fixtures/l1/constrained.json" } },
  });
  const parsed = validateLessonDoc(lesson);
  assert.equal(parsed.fixtures.constrained.kind, "claudeStream");
});

test("validateLessonDoc accepts every step type", () => {
  const lesson = makeLesson({
    fixtures: {
      constrained: { path: "fixtures/l1/constrained.json" },
      drill: { path: "fixtures/l6/drill.json", kind: "shellTranscript" },
    },
    steps: [
      { type: "instruction", id: "intro", md: "Read me." },
      { type: "promptBuilder", id: "compose", suggestions: [{ text: "make a page" }], slots: [{ name: "task", choices: ["make a page"] }] },
      {
        type: "run",
        id: "run",
        branches: { constrained: { fixture: "constrained", expectedPrompt: "make a page", permissionMode: "plan", model: "claude-haiku-4-5-20251001" } },
        pacing: "step",
      },
      {
        type: "annotation",
        id: "note",
        fixtureKey: "constrained",
        anchor: { ordinal: 2, frameType: "tool_use", where: { tool: "Edit", pathIncludes: "index.html" } },
        md: "This is the edit.",
      },
      { type: "permissionPrompt", id: "gate", branches: { allow: "constrained", deny: "constrained" } },
      { type: "quiz", id: "quiz", question: "Why?", options: ["a", "b"], answerIdx: 0, explainMd: "Because." },
      { type: "assertion", id: "grade", rule: { type: "quizCorrect", stepId: "quiz" } },
      { type: "terminalDrill", id: "drill", expect: { kind: "exact", value: "git diff" }, transcript: "drill" },
    ],
    completion: { assertionIds: ["grade", "quiz"], next: null },
  });
  const parsed = validateLessonDoc(lesson);
  assert.equal(parsed.steps.length, 8);
});

test("validateLessonDoc accepts the new assertion rules", () => {
  for (const rule of [
    { type: "streamEvent", match: { frameType: "tool_use", where: { tool: "Bash" } } },
    { type: "userChoice", equals: "deny" },
    { type: "diffTouchedOnly", paths: ["index.html"] },
    { type: "drillPassed", stepId: "drill" },
  ]) {
    const lesson = makeLesson();
    lesson.steps[3] = { type: "assertion", id: "grade", rule };
    assert.doesNotThrow(() => validateLessonDoc(lesson), `rule ${rule.type}`);
  }
});

test("validateLessonDoc rejects unknown step type", () => {
  const lesson = makeLesson();
  lesson.steps.push({ type: "cutscene", id: "x" });
  assert.throws(() => validateLessonDoc(lesson), /Invalid lesson/);
});

test("validateLessonDoc rejects duplicate step ids", () => {
  const lesson = makeLesson();
  lesson.steps.push({ type: "instruction", id: "intro", md: "again" });
  assert.throws(() => validateLessonDoc(lesson), /duplicate step id/);
});

test("validateLessonDoc rejects completion pointing at a missing step", () => {
  const lesson = makeLesson({ completion: { assertionIds: ["nope"], next: null } });
  assert.throws(() => validateLessonDoc(lesson), /unknown step/);
});

test("validateLessonDoc rejects completion pointing at a non-assertion step", () => {
  const lesson = makeLesson({ completion: { assertionIds: ["intro"], next: null } });
  assert.throws(() => validateLessonDoc(lesson), /not an assertion or quiz step/);
});

test("validateLessonDoc rejects run branch with unknown fixture key", () => {
  const lesson = makeLesson();
  lesson.steps[2].branches.constrained.fixture = "missing";
  assert.throws(() => validateLessonDoc(lesson), /unknown fixture key/);
});

test("validateLessonDoc rejects annotation with unknown fixture key", () => {
  const lesson = makeLesson();
  lesson.steps.splice(3, 0, {
    type: "annotation",
    id: "note",
    fixtureKey: "missing",
    anchor: { ordinal: 1, frameType: "tool_use" },
    md: "x",
  });
  assert.throws(() => validateLessonDoc(lesson), /unknown fixture key/);
});

test("validateLessonDoc rejects anchor with unknown frame type", () => {
  const lesson = makeLesson();
  lesson.steps.splice(3, 0, {
    type: "annotation",
    id: "note",
    fixtureKey: "constrained",
    anchor: { ordinal: 1, frameType: "bogus_frame" },
    md: "x",
  });
  assert.throws(() => validateLessonDoc(lesson), /unknown frame type/);
});

test("validateLessonDoc rejects wrong schemaVersion", () => {
  assert.throws(() => validateLessonDoc(makeLesson({ schemaVersion: 2 })), /Invalid lesson/);
});

test("validateLessonManifest accepts an ordered manifest", () => {
  const manifest = { schemaVersion: LESSON_SCHEMA_VERSION, lessons: [makeLesson()] };
  const parsed = validateLessonManifest(manifest);
  assert.equal(parsed.lessons.length, 1);
});

test("validateLessonManifest rejects an empty lesson list", () => {
  assert.throws(() => validateLessonManifest({ schemaVersion: LESSON_SCHEMA_VERSION, lessons: [] }));
});
