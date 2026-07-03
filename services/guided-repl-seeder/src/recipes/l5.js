/**
 * L5 "Permission modes & the leash" — the same edit run under plan,
 * acceptEdits, and bypassPermissions so learners can compare how many
 * review checkpoints each mode inserts before the risky edit lands.
 */

export const recipe = {
  lessonId: "l5",
  seedFrom: "l4-output",
  outputBranch: "acceptEdits",
  branches: {
    plan: { kind: "plan" },
    acceptEdits: { kind: "simple", permissionMode: "acceptEdits" },
    bypass: { kind: "simple", permissionMode: "bypassPermissions" },
  },
};
