/**
 * L4 "Plan mode & prompt planning" — approve a plan as-is, or revise it
 * (a second plan pass with a revised prompt) before approving. The revised
 * prompt text lives here (`promptVariants`) since it's a recording detail,
 * not a learner-facing branch prompt in lessons.json.
 */

export const recipe = {
  lessonId: "l4",
  seedFrom: "l3-output",
  outputBranch: "approve",
  branches: {
    approve: { kind: "plan" },
    revise: {
      kind: "multiplan",
      segments: ["plan_v1", "plan_v2", "exec"],
      gates: [
        ["revise", "approve"],
        ["approve", "deny"],
      ],
    },
  },
  promptVariants: {
    revise: {
      plan_v2:
        "add a skills section to the page listing 5 example skills with short descriptions, keep it one file",
    },
  },
};
