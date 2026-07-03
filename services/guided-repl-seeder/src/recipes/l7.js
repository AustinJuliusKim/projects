/**
 * L7 "CLAUDE.md — teaching your agent" — the same prompt run with and
 * without a CLAUDE.md conventions file in the workspace. The convention is
 * a distinctive, non-default one (new CSS custom properties must be
 * `--gp-`-prefixed) so the with/without diff is legible.
 */

const CLAUDE_MD = `# Project conventions

- Any new CSS custom property must be prefixed `+"`--gp-`"+` (e.g. `+"`--gp-highlight`"+`).
- Keep the whole site in a single index.html file with inline CSS.
- Use Title Case for new section headings.
`;

export const recipe = {
  lessonId: "l7",
  seedFrom: "l6-output",
  outputBranch: "with",
  branches: {
    without: { kind: "simple", permissionMode: "acceptEdits", snapshotId: "l7-input-plain" },
    with: {
      kind: "simple",
      permissionMode: "acceptEdits",
      snapshotId: "l7-input-claudemd",
      extraFiles: [{ path: "CLAUDE.md", content: CLAUDE_MD }],
    },
  },
};
