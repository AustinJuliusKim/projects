/**
 * Headless lesson engine: a pure reducer over the authored step sequence.
 * Owns lesson progress, step results, and the Stage/Rail mode — the Rail is
 * its only full subscriber; stage components receive just the mode string
 * (Lesson Engine Spec §3: separation enforced by props, not discipline).
 *
 * Modes: instructing → prompting → running → reflecting → … → graduated.
 * `running` persists through the session's awaiting_permission status — the
 * engine stays on the run step until run_done.
 *
 * @typedef {"instructing"|"prompting"|"running"|"reflecting"|"graduated"} LessonMode
 *
 * @typedef {object} EngineState
 * @property {object|null} lesson indexed lesson (with steps)
 * @property {number} stepIndex index into lesson.steps
 * @property {Record<string, object>} results stepId → quiz/assertion/drill result
 * @property {string|null} activeBranchId
 * @property {boolean} drillRunning
 * @property {boolean} graduated
 */

import { evaluate } from "../grading/assertionEvaluator.js";

/** Steps the learner moves through; annotation steps are playback metadata, not stops. */
function isFlowStep(step) {
  return step.type !== "annotation";
}

/** @returns {EngineState} */
export function createEngineState(lesson = null) {
  return {
    lesson,
    stepIndex: lesson ? firstFlowIndex(lesson.steps, 0) : 0,
    results: {},
    activeBranchId: null,
    drillRunning: false,
    graduated: false,
  };
}

/** @returns {number} index of the first flow step at or after `from` (steps.length when past the end) */
function firstFlowIndex(steps, from) {
  let i = from;
  while (i < steps.length && !isFlowStep(steps[i])) i++;
  return i;
}

/** @param {EngineState} state */
export function currentStep(state) {
  return state.lesson?.steps[state.stepIndex] ?? null;
}

/**
 * @param {EngineState} state
 * @returns {LessonMode}
 */
export function stageMode(state) {
  if (state.graduated) return "graduated";
  const step = currentStep(state);
  if (!step) return "instructing";
  switch (step.type) {
    case "instruction":
      return "instructing";
    case "promptBuilder":
      return "prompting";
    case "run":
      return "running";
    case "terminalDrill":
      return state.drillRunning ? "running" : "prompting";
    case "quiz":
    case "assertion":
      return "reflecting";
    case "capture":
      return "instructing";
    default:
      return "instructing";
  }
}

/** True when every completion assertion step has a passing result. */
function completionSatisfied(state) {
  return state.lesson.completion.assertionIds.every((id) => state.results[id]?.pass);
}

function advanceFrom(state, index) {
  const steps = state.lesson.steps;
  const next = firstFlowIndex(steps, index + 1);
  if (next >= steps.length) {
    return { ...state, stepIndex: steps.length - 1, graduated: completionSatisfied(state) || state.graduated };
  }
  return { ...state, stepIndex: next };
}

/**
 * @param {EngineState} state
 * @param {object} action
 * @returns {EngineState}
 */
export function engineReducer(state, action) {
  switch (action.type) {
    case "lesson_loaded":
      return createEngineState(action.lesson);

    case "advance": {
      if (!state.lesson) return state;
      const step = currentStep(state);
      // Continue past the final assertion once passed → graduated.
      if (step && (step.type === "assertion" || step.type === "quiz") && state.results[step.id]?.pass) {
        return advanceFrom(state, state.stepIndex);
      }
      if (step && (step.type === "instruction")) {
        return advanceFrom(state, state.stepIndex);
      }
      return state;
    }

    case "prompt_matched": {
      // The composer is always live in the stage, so a submit can arrive
      // from the instruction step (or a re-run from reflecting) — jump to
      // the lesson's run step rather than requiring strict step order.
      if (!state.lesson) return state;
      const runIndex = state.lesson.steps.findIndex((s) => s.type === "run");
      if (runIndex === -1) return state;
      return { ...state, activeBranchId: action.branchId, stepIndex: runIndex };
    }

    case "run_done": {
      const step = currentStep(state);
      if (step?.type === "run") {
        return advanceFrom(state, state.stepIndex);
      }
      if (step?.type === "terminalDrill" && state.drillRunning) {
        const results = { ...state.results, [step.id]: { pass: true } };
        return advanceFrom({ ...state, results, drillRunning: false }, state.stepIndex);
      }
      return state;
    }

    case "drill_matched": {
      const step = currentStep(state);
      if (step?.type !== "terminalDrill") return state;
      return { ...state, drillRunning: true };
    }

    case "quiz_answered": {
      const step = currentStep(state);
      if (step?.type !== "quiz" || step.id !== action.stepId) return state;
      const pass = action.answerIdx === step.answerIdx;
      const results = { ...state.results, [step.id]: { pass, answerIdx: action.answerIdx } };
      const next = { ...state, results };
      // Correct answers advance to the grading step; wrong answers are soft —
      // the learner re-answers in place.
      return pass ? advanceFrom(next, state.stepIndex) : next;
    }

    case "assertion_evaluated": {
      const step = currentStep(state);
      if (step?.type !== "assertion" || step.id !== action.stepId) return state;
      const results = { ...state.results, [step.id]: action.result };
      const next = { ...state, results };
      // The last flow step grading pass graduates immediately (banner +
      // next-lesson affordance render together in the Rail).
      const atEnd = firstFlowIndex(state.lesson.steps, state.stepIndex + 1) >= state.lesson.steps.length;
      if (action.result.pass && atEnd && completionSatisfied(next)) {
        return { ...next, graduated: true };
      }
      // Mid-lesson pass advances (mirrors quiz) — enables post-assertion
      // steps like the email capture; GradeBanner stays visible via
      // railModel's latestAssertionResult.
      if (action.result.pass && !atEnd) {
        return advanceFrom(next, state.stepIndex);
      }
      return next;
    }

    case "capture_submitted": {
      const step = currentStep(state);
      if (step?.type !== "capture" || step.id !== action.stepId) return state;
      const results = { ...state.results, [step.id]: { pass: true, values: action.values } };
      return advanceFrom({ ...state, results }, state.stepIndex);
    }

    case "capture_skipped": {
      const step = currentStep(state);
      if (step?.type !== "capture" || step.id !== action.stepId || !step.optional) return state;
      const results = { ...state.results, [step.id]: { pass: true, skipped: true } };
      return advanceFrom({ ...state, results }, state.stepIndex);
    }

    case "retry": {
      if (!state.lesson) return state;
      const builderIndex = state.lesson.steps.findIndex((s) => s.type === "promptBuilder");
      return {
        ...createEngineState(state.lesson),
        stepIndex: builderIndex === -1 ? firstFlowIndex(state.lesson.steps, 0) : builderIndex,
      };
    }

    case "reset":
      return createEngineState(state.lesson);

    default:
      return state;
  }
}

/**
 * Evaluates an assertion step's rule. Legacy rule types delegate to the
 * existing assertionEvaluator; engine-level rules (quizCorrect, drillPassed)
 * read step results.
 *
 * @param {object} rule
 * @param {{files: object, messages: Array<object>, results: Record<string, object>}} ctx
 * @returns {{pass: boolean, detail: string}}
 */
export function evaluateRule(rule, { files, messages, results }) {
  switch (rule.type) {
    case "quizCorrect": {
      const result = results[rule.stepId];
      return result?.pass
        ? { pass: true, detail: "Correct" }
        : { pass: false, detail: "Answer the quiz to complete the lesson" };
    }
    case "drillPassed": {
      const result = results[rule.stepId];
      return result?.pass
        ? { pass: true, detail: "Drill completed" }
        : { pass: false, detail: "Complete the terminal drill" };
    }
    default:
      return evaluate(rule, { files, messages });
  }
}

/**
 * Rail view model: everything the Rail renders, in one derived object.
 *
 * @param {EngineState} state
 */
export function railModel(state) {
  if (!state.lesson) {
    return { mode: "instructing", dots: [], instructionMd: null, currentStep: null, results: {}, graduated: false, latestAssertionResult: null };
  }
  const steps = state.lesson.steps;
  const flowSteps = steps.filter(isFlowStep);
  const currentFlowIdx = flowSteps.indexOf(steps[state.stepIndex]);
  const dots = flowSteps.map((step, i) => ({
    id: step.id,
    state: state.graduated || i < currentFlowIdx ? "done" : i === currentFlowIdx ? "active" : "pending",
  }));

  // The most recent instruction at or before the current step stays visible
  // while the learner acts on it.
  let instructionMd = null;
  for (let i = state.stepIndex; i >= 0; i--) {
    if (steps[i].type === "instruction") {
      instructionMd = steps[i].md;
      break;
    }
  }

  // The most recent assertion result at or before the current step — keeps
  // the GradeBanner visible while a post-assertion capture step is current.
  let latestAssertionResult = null;
  for (let i = Math.min(state.stepIndex, steps.length - 1); i >= 0; i--) {
    if (steps[i].type === "assertion" && state.results[steps[i].id]) {
      latestAssertionResult = state.results[steps[i].id];
      break;
    }
  }

  return {
    mode: stageMode(state),
    dots,
    instructionMd,
    currentStep: currentStep(state),
    results: state.results,
    graduated: state.graduated,
    latestAssertionResult,
  };
}
