# foundry-worker notes (deviations & open questions)

- **Ship-time reminder:** repo CLAUDE.md requires `/vault-sync` before shipping/opening a
  PR after changes under apps/packages/services. This worker never ships or opens PRs
  (hard rule), so vault sync is deferred to whoever ships this branch. Vault deltas to
  reflect: Foundry built per spec v1.3; package path is guided-repl-lessons (spec says
  claude-repl-lessons); E2B runner now real; checkLessons chain generalized for
  self-contained draft roots.
- **Task 13 — GITHUB_TOKEN-fallback warning (supervisor cycle 4 watch item):** handled
  workflow-side — foundry.yml appends the warning to each bundle's PR_BODY.md before
  `gh pr create` when FOUNDRY_PR_TOKEN is absent (workflowGuard asserts the text).
  `buildDraftBundle`'s `tokenWarning` param remains for future CLI-side wiring.
- **Task 11 — files beyond the brief's list:** `src/run.js` (pipeline orchestration,
  importable for tests) and `src/dryrun.js` (built-in --dry-run fakes the brief requires
  behaviorally but doesn't list as a file). Both keep cli.js thin; no scope change.

- **Task 1 — foundry package deps:** added `"guided-repl-seeder": "file:../guided-repl-seeder"`
  to `services/guided-repl-foundry/package.json`, beyond the brief's listed deps
  (agent-sdk, yaml, zod, protocol, lessons). Task 10's `validateDraft.js` must import the
  seeder's `seedLib.js`/`docRecipe.js`; a file: link is cleaner and more robust than a
  cross-package relative import. No behavior impact.
- **Task 1 — bin points at a future file:** `services/guided-repl-foundry/package.json`
  declares `bin: {"foundry": "./src/cli.js"}`, which won't exist until Task 11. Harmless
  meanwhile (nothing invokes the bin), noted per supervisor review cycle 1.
- **Task 1 — seeder cli.js mode flips:** `npm ci`/`npm install` in the foundry package
  chmods the file:-linked seeder bin target (`services/guided-repl-seeder/src/cli.js`
  644→755). Keep this mode-only change out of every commit until Task 7 touches the
  seeder deliberately (`git checkout -- services/guided-repl-seeder/src/cli.js`).
- **Task 7 — commit-message inaccuracy (supervisor cycle 2):** the Task 7 commit message
  says it includes the cli.js chmod 644→755, but the committed tree carries no mode
  change (the flip had been reset before staging). History not rewritten per supervisor;
  the npm-induced mode flip stays excluded from commits unless one genuinely needs it.
- **Task 1 — `anthropic-news` RSS URL:** `foundry/sources.yaml` uses
  `https://www.anthropic.com/news/rss.xml`, which is plausible but unverified (no live
  network calls allowed here). Fetchers are failure-isolated, so a wrong URL degrades
  rather than breaks a run; verify/fix at the first supervised run / registry review
  (manual op in the brief §5).
