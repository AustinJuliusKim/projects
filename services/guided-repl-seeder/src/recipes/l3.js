/**
 * L3 "The prompt ladder" — restyle the shipped page: vague vs. constrained
 * vs. planned. Content (prompts, quiz) lives in lessons.json; this recipe
 * only carries recording instructions.
 */

export const recipe = {
  lessonId: "l3",
  seedFrom: "l1-output",
  outputBranch: "constrained",
  branches: {
    vague: { kind: "simple", permissionMode: "acceptEdits" },
    constrained: { kind: "simple", permissionMode: "acceptEdits" },
    "plan-mode": { kind: "plan" },
  },
};
