/**
 * L8 "Cost, models & going live" — the same small edit on Haiku vs. the
 * session default (Sonnet-class) model, with usage.model stamped from the
 * real system/init stream rather than hardcoded.
 */

export const recipe = {
  lessonId: "l8",
  seedFrom: "l7-output",
  outputBranch: "sonnet",
  branches: {
    haiku: { kind: "model", permissionMode: "acceptEdits", model: "claude-haiku-4-5-20251001" },
    sonnet: { kind: "model", permissionMode: "acceptEdits", model: "claude-sonnet-5" },
  },
};
