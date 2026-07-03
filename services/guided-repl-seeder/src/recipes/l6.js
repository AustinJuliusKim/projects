/**
 * L6 "Reading diffs & verifying" — a clean branch and a planted-bug branch.
 * The bug is engineered via the prompt itself (told to reference a CSS
 * class it's explicitly instructed not to define), so it's a deterministic,
 * visible defect rather than relying on the model to "break" something on
 * its own. The file-contains assertion's exact match token is finalized in
 * lessons.json after recording, once the real output is inspected.
 */

export const recipe = {
  lessonId: "l6",
  seedFrom: "l5-output",
  outputBranch: "clean",
  branches: {
    clean: { kind: "simple", permissionMode: "acceptEdits" },
    "planted-bug": { kind: "simple", permissionMode: "acceptEdits" },
  },
};
