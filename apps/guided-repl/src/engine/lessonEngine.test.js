import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEngineState,
  engineReducer,
  stageMode,
  currentStep,
  evaluateRule,
  railModel,
} from "./lessonEngine.js";

/** A converted-shape lesson: instruction → compose → run → quiz → grade. */
function quizLesson() {
  return {
    lessonId: "l5",
    steps: [
      { type: "instruction", id: "intro", md: "Read." },
      { type: "promptBuilder", id: "compose", suggestions: [{ text: "p", branchId: "plan" }] },
      { type: "run", id: "run", branches: { plan: { fixture: "plan", expectedPrompt: "p", permissionMode: "plan" } } },
      { type: "quiz", id: "quiz", question: "?", options: ["a", "b"], answerIdx: 0 },
      { type: "assertion", id: "grade", rule: { type: "quizCorrect", stepId: "quiz" } },
    ],
    completion: { assertionIds: ["grade"], next: "l6" },
  };
}

/** The l1 template shape: annotation step interleaved, file assertion. */
function fileLesson() {
  return {
    lessonId: "l1",
    steps: [
      { type: "instruction", id: "intro", md: "Read." },
      { type: "promptBuilder", id: "compose", suggestions: [{ text: "p", branchId: "constrained" }] },
      { type: "run", id: "run", branches: { constrained: { fixture: "c", expectedPrompt: "p", permissionMode: "acceptEdits" } } },
      {
        type: "annotation",
        id: "note",
        fixtureKey: "constrained",
        anchor: { ordinal: 1, frameType: "tool_use" },
        md: "x",
        resolvedEventIndex: 4,
      },
      { type: "assertion", id: "grade", rule: { type: "file-contains", path: "index.html", match: "<h1>" } },
    ],
    completion: { assertionIds: ["grade"], next: "l2" },
  };
}

function drillLesson() {
  return {
    lessonId: "l6",
    steps: [
      { type: "instruction", id: "intro", md: "Type it yourself." },
      { type: "terminalDrill", id: "try-git", expect: { kind: "exact", value: "git diff" }, transcript: "drill" },
      { type: "assertion", id: "grade", rule: { type: "drillPassed", stepId: "try-git" } },
    ],
    completion: { assertionIds: ["grade"], next: null },
  };
}

test("walks the full quiz lesson through every mode", () => {
  let s = createEngineState(quizLesson());
  assert.equal(stageMode(s), "instructing");

  s = engineReducer(s, { type: "advance" });
  assert.equal(stageMode(s), "prompting");

  s = engineReducer(s, { type: "prompt_matched", branchId: "plan" });
  assert.equal(stageMode(s), "running");
  assert.equal(s.activeBranchId, "plan");

  s = engineReducer(s, { type: "run_done" });
  assert.equal(stageMode(s), "reflecting");
  assert.equal(currentStep(s).id, "quiz");

  // Wrong answer: soft — stays on the quiz.
  s = engineReducer(s, { type: "quiz_answered", stepId: "quiz", answerIdx: 1 });
  assert.equal(currentStep(s).id, "quiz");
  assert.equal(s.results.quiz.pass, false);

  // Correct answer advances to the grading step.
  s = engineReducer(s, { type: "quiz_answered", stepId: "quiz", answerIdx: 0 });
  assert.equal(currentStep(s).id, "grade");

  const result = evaluateRule(currentStep(s).rule, { files: {}, messages: [], results: s.results });
  assert.equal(result.pass, true);
  s = engineReducer(s, { type: "assertion_evaluated", stepId: "grade", result });
  assert.equal(stageMode(s), "graduated");
  assert.ok(s.graduated);
});

test("annotation steps are skipped in the flow (playback metadata only)", () => {
  let s = createEngineState(fileLesson());
  s = engineReducer(s, { type: "advance" });
  s = engineReducer(s, { type: "prompt_matched", branchId: "constrained" });
  s = engineReducer(s, { type: "run_done" });
  // run → (annotation skipped) → assertion
  assert.equal(currentStep(s).id, "grade");
  assert.equal(stageMode(s), "reflecting");
});

test("failed assertion does not graduate; retry returns to the composer", () => {
  let s = createEngineState(fileLesson());
  s = engineReducer(s, { type: "advance" });
  s = engineReducer(s, { type: "prompt_matched", branchId: "constrained" });
  s = engineReducer(s, { type: "run_done" });

  s = engineReducer(s, { type: "assertion_evaluated", stepId: "grade", result: { pass: false, detail: "nope" } });
  assert.equal(stageMode(s), "reflecting");
  assert.ok(!s.graduated);

  s = engineReducer(s, { type: "retry" });
  assert.equal(stageMode(s), "prompting");
  assert.deepEqual(s.results, {});
  assert.equal(s.activeBranchId, null);
});

test("drill flow: prompting → running on match → drillPassed on run_done", () => {
  let s = createEngineState(drillLesson());
  s = engineReducer(s, { type: "advance" });
  assert.equal(stageMode(s), "prompting");
  assert.equal(currentStep(s).type, "terminalDrill");

  s = engineReducer(s, { type: "drill_matched" });
  assert.equal(stageMode(s), "running");

  s = engineReducer(s, { type: "run_done" });
  assert.equal(s.results["try-git"].pass, true);
  assert.equal(currentStep(s).id, "grade");

  const result = evaluateRule(currentStep(s).rule, { files: {}, messages: [], results: s.results });
  assert.equal(result.pass, true);
});

test("evaluateRule delegates legacy rules to the assertion evaluator", () => {
  const files = { "index.html": { content: "<h1>hi</h1>" } };
  const result = evaluateRule(
    { type: "file-contains", path: "index.html", match: "<h1>" },
    { files, messages: [], results: {} },
  );
  assert.equal(result.pass, true);
});

test("quizCorrect fails until the quiz result passes", () => {
  const rule = { type: "quizCorrect", stepId: "quiz" };
  assert.equal(evaluateRule(rule, { files: {}, messages: [], results: {} }).pass, false);
  assert.equal(evaluateRule(rule, { files: {}, messages: [], results: { quiz: { pass: true } } }).pass, true);
});

test("railModel exposes dots, instruction copy, and mode", () => {
  let s = createEngineState(quizLesson());
  let rail = railModel(s);
  assert.equal(rail.mode, "instructing");
  assert.equal(rail.dots.length, 5);
  assert.deepEqual(rail.dots[0], { id: "intro", state: "active" });
  assert.equal(rail.instructionMd, "Read.");

  s = engineReducer(s, { type: "advance" });
  rail = railModel(s);
  assert.equal(rail.dots[0].state, "done");
  assert.equal(rail.dots[1].state, "active");
  // The instruction copy stays visible while the learner acts on it.
  assert.equal(rail.instructionMd, "Read.");
});

test("lesson_loaded and reset rebuild initial state", () => {
  let s = createEngineState(quizLesson());
  s = engineReducer(s, { type: "advance" });
  s = engineReducer(s, { type: "lesson_loaded", lesson: fileLesson() });
  assert.equal(s.lesson.lessonId, "l1");
  assert.equal(stageMode(s), "instructing");

  s = engineReducer(s, { type: "advance" });
  s = engineReducer(s, { type: "reset" });
  assert.equal(stageMode(s), "instructing");
});
