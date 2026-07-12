/**
 * Lesson document schema — the single source of truth for authored lesson
 * configs (YAML sources compiled to canonical JSON by @guided-repl/lessons).
 *
 * Defined with Zod (the package's one runtime dependency) per the Lesson
 * Engine Spec: renderer, authoring compiler, and CI checks all validate
 * against these schemas.
 */

import { z } from "zod";
import { SERVER_TYPES } from "./frames.js";

export const LESSON_SCHEMA_VERSION = 1;

const stepId = z.string().min(1);

/**
 * Semantic anchor: selects the `ordinal`-th frame event of `frameType`
 * (optionally narrowed by `where`) in a fixture's event stream — e.g.
 * "2nd tool_use where tool=Edit, path includes index.html". Anchors survive
 * CI re-seeds; a selector that no longer resolves is a build error.
 */
export const SemanticAnchorSchema = z.object({
  ordinal: z.number().int().min(1),
  frameType: z.string().refine((t) => SERVER_TYPES.has(t), { message: "unknown frame type" }),
  where: z
    .object({
      tool: z.string().optional(),
      pathIncludes: z.string().optional(),
    })
    .optional(),
});

export const CmdMatcherSchema = z.object({
  kind: z.enum(["exact", "regex"]),
  value: z.string().min(1),
});

export const FixtureRefSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["claudeStream", "shellTranscript"]).default("claudeStream"),
});

const FsSnapshotRefSchema = z.object({
  snapshotId: z.string().min(1),
});

/**
 * Assertion rules: the five legacy assertion shapes (unchanged, so
 * assertionEvaluator keeps working) plus the spec's new data-only rules.
 */
export const AssertionRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file-contains"), path: z.string(), match: z.string() }),
  z.object({ type: z.literal("file-exists"), path: z.string() }),
  z.object({ type: z.literal("terminal-matches"), match: z.string() }),
  z.object({ type: z.literal("file-equals"), path: z.string(), content: z.string() }),
  z.object({
    type: z.literal("quiz"),
    question: z.string(),
    choices: z.array(z.string()).min(2),
    correctIndex: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("streamEvent"),
    match: z.object({ frameType: z.string(), where: z.object({ tool: z.string().optional(), pathIncludes: z.string().optional() }).optional() }),
  }),
  z.object({ type: z.literal("quizCorrect"), stepId }),
  z.object({ type: z.literal("userChoice"), equals: z.string() }),
  z.object({ type: z.literal("diffTouchedOnly"), paths: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("drillPassed"), stepId }),
]);

const SuggestionSchema = z.object({
  text: z.string().min(1),
  description: z.string().optional(),
  /**
   * Explicit branch selection. Required when the same prompt text maps to
   * more than one branch (l4/l5/l7/l8 counterfactuals); the composer submits
   * {text, branchId} and the transport prefers branchId over prompt matching.
   */
  branchId: z.string().optional(),
});

const ChoiceSlotSchema = z.object({
  name: z.string().min(1),
  choices: z.array(z.string().min(1)).min(1),
});

const RunBranchSchema = z.object({
  fixture: z.string().min(1), // key into the lesson's fixtures{} map
  expectedPrompt: z.string().min(1),
  permissionMode: z.string().min(1),
  seedSnapshotId: z.string().optional(),
  model: z.string().optional(),
});

export const StepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("instruction"), id: stepId, md: z.string().min(1) }),
  z.object({
    type: z.literal("promptBuilder"),
    id: stepId,
    suggestions: z.array(SuggestionSchema).min(1),
    slots: z.array(ChoiceSlotSchema).optional(),
  }),
  z.object({
    type: z.literal("run"),
    id: stepId,
    branches: z.record(z.string(), RunBranchSchema),
    pacing: z.enum(["auto", "step"]).optional(),
  }),
  z.object({
    type: z.literal("annotation"),
    id: stepId,
    fixtureKey: z.string().min(1),
    anchor: SemanticAnchorSchema,
    md: z.string().min(1),
    resolvedEventIndex: z.number().int().min(0).optional(), // stamped by the compiler
  }),
  z.object({
    type: z.literal("permissionPrompt"),
    id: stepId,
    branches: z.object({ allow: z.string().min(1), deny: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("quiz"),
    id: stepId,
    question: z.string().min(1),
    options: z.array(z.string()).min(2),
    answerIdx: z.number().int().min(0),
    explainMd: z.string().optional(),
  }),
  z.object({ type: z.literal("assertion"), id: stepId, rule: AssertionRuleSchema }),
  z.object({
    type: z.literal("terminalDrill"),
    id: stepId,
    expect: CmdMatcherSchema,
    transcript: z.string().min(1), // key into the lesson's fixtures{} map
  }),
  z.object({
    type: z.literal("capture"),
    id: stepId,
    fields: z.array(z.enum(["name", "email"])).min(1),
    purposeMd: z.string().min(1),
    optional: z.boolean().default(true),
    consent: z.object({ label: z.string().min(1) }).optional(),
  }),
]);

export const LessonSchema = z
  .object({
    schemaVersion: z.literal(LESSON_SCHEMA_VERSION),
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    track: z.enum(["guided", "advanced", "dev-basics"]),
    order: z.number().int().min(1),
    durationTargetSec: z.number().int().min(1),
    prereqs: z.array(z.string()),
    locked: z.boolean().optional(),
    snapshot: FsSnapshotRefSchema,
    steps: z.array(StepSchema).min(1),
    fixtures: z.record(z.string(), FixtureRefSchema),
    completion: z.object({
      assertionIds: z.array(stepId).min(1),
      next: z.string().nullable(),
    }),
  })
  .superRefine((lesson, ctx) => {
    const ids = new Set();
    for (const step of lesson.steps) {
      if (ids.has(step.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate step id "${step.id}"` });
      }
      ids.add(step.id);
    }
    for (const id of lesson.completion.assertionIds) {
      const step = lesson.steps.find((s) => s.id === id);
      if (!step) {
        ctx.addIssue({ code: "custom", message: `completion.assertionIds references unknown step "${id}"` });
      } else if (step.type !== "assertion" && step.type !== "quiz") {
        ctx.addIssue({ code: "custom", message: `completion.assertionIds step "${id}" is not an assertion or quiz step` });
      }
    }
    const fixtureKeys = new Set(Object.keys(lesson.fixtures));
    for (const step of lesson.steps) {
      if (step.type === "run") {
        for (const [branchId, branch] of Object.entries(step.branches)) {
          if (!fixtureKeys.has(branch.fixture)) {
            ctx.addIssue({ code: "custom", message: `run step "${step.id}" branch "${branchId}" references unknown fixture key "${branch.fixture}"` });
          }
        }
      }
      if (step.type === "annotation" && !fixtureKeys.has(step.fixtureKey)) {
        ctx.addIssue({ code: "custom", message: `annotation step "${step.id}" references unknown fixture key "${step.fixtureKey}"` });
      }
      if (step.type === "terminalDrill" && !fixtureKeys.has(step.transcript)) {
        ctx.addIssue({ code: "custom", message: `terminalDrill step "${step.id}" references unknown fixture key "${step.transcript}"` });
      }
    }
  });

/** The compiled manifest shipped to the app: all lessons, ordered. */
export const LessonManifestSchema = z.object({
  schemaVersion: z.literal(LESSON_SCHEMA_VERSION),
  lessons: z.array(LessonSchema).min(1),
});

/**
 * Validates a lesson document, throwing with a readable message on the
 * first problem found (matching the package's validator conventions).
 *
 * @param {unknown} obj
 * @returns {import("zod").infer<typeof LessonSchema>} the parsed lesson (with defaults applied)
 * @throws {Error}
 */
export function validateLessonDoc(obj) {
  const result = LessonSchema.safeParse(obj);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length ? ` at ${first.path.join(".")}` : "";
    throw new Error(`Invalid lesson${path}: ${first.message}`);
  }
  return result.data;
}

/**
 * Validates a compiled lesson manifest ({schemaVersion, lessons[]}).
 *
 * @param {unknown} obj
 * @returns {import("zod").infer<typeof LessonManifestSchema>}
 * @throws {Error}
 */
export function validateLessonManifest(obj) {
  const result = LessonManifestSchema.safeParse(obj);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length ? ` at ${first.path.join(".")}` : "";
    throw new Error(`Invalid lesson manifest${path}: ${first.message}`);
  }
  return result.data;
}
