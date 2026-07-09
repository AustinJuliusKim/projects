import test from "node:test";
import assert from "node:assert/strict";

import { convertLesson, convertAll, slugify } from "../src/convertLegacy.js";

const legacyQuizLesson = {
  lessonId: "l5",
  title: "Permission modes & the leash",
  locked: false,
  branches: ["plan", "acceptEdits"],
  seedSnapshotId: "l4-output",
  promptChoices: { task: ["rewrite"], subject: ["the section"], constraint: ["one file"] },
  branchConfig: {
    plan: { expectedPrompt: "rewrite the section, one file", permissionMode: "plan", fixture: "fixtures/l5/plan.json" },
    acceptEdits: { expectedPrompt: "rewrite the section, one file", permissionMode: "acceptEdits", fixture: "fixtures/l5/acceptEdits.json" },
  },
  assertion: { type: "quiz", question: "Which mode pauses?", choices: ["plan", "acceptEdits"], correctIndex: 0 },
};

test("slugify", () => {
  assert.equal(slugify("CLAUDE.md — teaching your agent"), "claude-md-teaching-your-agent");
});

test("convertLesson maps branches to fixtures/run and stamps explicit branchIds", () => {
  const doc = convertLesson(legacyQuizLesson, 5, "l4", "l6");
  assert.equal(doc.id, "l5");
  assert.equal(doc.order, 5);
  assert.deepEqual(doc.prereqs, ["l4"]);
  assert.equal(doc.completion.next, "l6");
  assert.deepEqual(Object.keys(doc.fixtures), ["plan", "acceptEdits"]);

  const builder = doc.steps.find((s) => s.type === "promptBuilder");
  // Duplicate expectedPrompts across branches: every suggestion must carry
  // an explicit branchId so both counterfactuals are reachable.
  assert.deepEqual(
    builder.suggestions.map((s) => s.branchId),
    ["plan", "acceptEdits"],
  );
  assert.ok(builder.suggestions[0].description !== builder.suggestions[1].description);
});

test("convertLesson turns quiz assertions into quiz + quizCorrect steps", () => {
  const doc = convertLesson(legacyQuizLesson, 5, "l4", "l6");
  const quiz = doc.steps.find((s) => s.type === "quiz");
  assert.equal(quiz.answerIdx, 0);
  const grade = doc.steps.find((s) => s.type === "assertion");
  assert.deepEqual(grade.rule, { type: "quizCorrect", stepId: "quiz" });
  assert.deepEqual(doc.completion.assertionIds, ["grade"]);
});

test("convertLesson keeps non-quiz assertions verbatim", () => {
  const legacy = {
    ...legacyQuizLesson,
    lessonId: "l6",
    assertion: { type: "file-contains", path: "index.html", match: ".testimonial-card" },
  };
  const doc = convertLesson(legacy, 6, "l5", "l7");
  const grade = doc.steps.find((s) => s.type === "assertion");
  assert.deepEqual(grade.rule, legacy.assertion);
});

test("convertLesson preserves branch seedSnapshotId and model overrides", () => {
  const legacy = {
    ...legacyQuizLesson,
    branchConfig: {
      plan: { ...legacyQuizLesson.branchConfig.plan, seedSnapshotId: "special", model: "claude-haiku-4-5-20251001" },
      acceptEdits: legacyQuizLesson.branchConfig.acceptEdits,
    },
  };
  const doc = convertLesson(legacy, 5, "l4", "l6");
  const run = doc.steps.find((s) => s.type === "run");
  assert.equal(run.branches.plan.seedSnapshotId, "special");
  assert.equal(run.branches.plan.model, "claude-haiku-4-5-20251001");
  assert.ok(!("seedSnapshotId" in run.branches.acceptEdits));
});

test("convertLesson carries playback step into run pacing", () => {
  const legacy = { ...legacyQuizLesson, playback: "step" };
  const run = convertLesson(legacy, 5, "l4", "l6").steps.find((s) => s.type === "run");
  assert.equal(run.pacing, "step");
});

test("convertAll chains prereqs and next across the spine", () => {
  const manifest = { lessons: [legacyQuizLesson, { ...legacyQuizLesson, lessonId: "l6" }] };
  const docs = convertAll(manifest);
  assert.deepEqual(docs[0].prereqs, []);
  assert.equal(docs[0].completion.next, "l6");
  assert.deepEqual(docs[1].prereqs, ["l5"]);
  assert.equal(docs[1].completion.next, null);
});
