# Recorder usage + redaction checklist

## Running

```
cd services/guided-repl-seeder
node src/cli.js l1
node src/cli.js all       # l1, then l2-l8 in chain order
node src/cli.js l6        # or one recipe-driven lesson at a time
```

`l1` runs all 3 lesson-1 branches (`vague`, `constrained`, `plan-mode`)
against a real local `claude -p` CLI:

- `vague`, `constrained` — one `acceptEdits` run each in a fresh tmp
  workspace (`os.tmpdir()/guided-repl-seed-*`, never inside this repo —
  `localRunner.js` hard-guards against a `cwd` under
  `/Users/aukim/personal/projects`).
- `plan-mode` — a `plan`-mode run followed by an `acceptEdits` run with the
  *same prompt* in the *same workspace* (the execution tail). Headless
  `--permission-mode plan` does not park for approval or expose
  `ExitPlanMode` — it just writes a plan file under `~/.claude/plans/` and
  exits cleanly with no workspace changes. `authorGate.js` splices the two
  runs together with a synthesized `{awaitClient: "permission", choices:
  ["approve", "deny"]}` marker and drops the execution run's duplicate
  `session_ready` frame.

Each run takes roughly 30–90s; the plan branch runs two, so budget up to
~6 minutes for it.

`l2` is not a live recording — it merges hand-authored annotations onto a
copy of L1's `constrained` fixture (see the seeder README's "L2: annotation
merge"). `l3`-`l8` are recipe-driven (`src/recipes/`) and chain off each
other's `<lessonId>-output` snapshot, so they must be recorded in chain
order the first time — `all` handles that automatically. A full `all` run
covers 18 branch fixtures across L1-L8 (17 with a live `claude -p` segment,
L2 merged); several branches run more than one `claude -p` segment
(`plan`/`multiplan` kinds), so the full production run is closer to two
dozen individual `claude -p` invocations end to end.

Output:

- `--out <dir>` (default `services/guided-repl-seeder/output/v1/`):
  `fixtures/<lessonId>/<branchId>.json`, `snapshots/<id>.json`.
- Mirrored automatically into
  `apps/guided-repl/public/fixtures/v1/{fixtures/<lessonId>/*.json,snapshots/*.json}`.
  `lessons.json` in that directory is the source of truth for each branch's
  `expectedPrompt`/`permissionMode`/model overrides and is not overwritten
  by the recorder.

`l1-input` is captured once from a pristine seed workspace (just the
starter `README.md`). `l1-output` is captured once, from the `constrained`
branch's post-run workspace — that's the branch expected to reliably
produce `index.html` with an `<h1>`, per the lesson's `file-contains`
assertion. `l3-output` through `l8-output` are each captured from their
recipe's `outputBranch` the same way, and L7 additionally captures
`l7-input-plain`/`l7-input-claudemd` (its two branch-specific seeds, one
with a `CLAUDE.md` layered in) before either branch runs.

## Redaction checklist (must pass before committing fixtures)

Every raw stream-json event that reaches disk goes through
`streamMapper.mapEvent` (shape mapping only) and then
`normalizer.normalizeFrame` (path/secret redaction) before pacing and
writing. Snapshot file *contents* go through the same `sanitizeString` (via
`snapshotter.js`) as they're read off disk, so seed/output workspace files
are redacted too, not just frame payloads.

`sanitizeString` (`normalizer.js`) redacts, in order: the run's workspace
cwd (both the plain path and its dash-mangled `~/.claude/projects/`-style
form), the user's home dir and the standalone username token, plan-file
paths (normalized to `~/.claude/plans/plan.md`), UUIDs, `sk-ant-*` keys,
email addresses, and any leftover `/Users`, `/private`, or `/var/folders`
path (including the dash-mangled `-private-var-folders-...` catchall form).

Before treating a recording as done, grep the written fixtures/snapshots
for leaks:

```
grep -rE '/Users/|/private|/var/folders|-private-var-folders-' services/guided-repl-seeder/output apps/guided-repl/public/fixtures/v1
grep -rEi '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' services/guided-repl-seeder/output apps/guided-repl/public/fixtures/v1
grep -rE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' services/guided-repl-seeder/output apps/guided-repl/public/fixtures/v1
grep -r 'sk-ant-' services/guided-repl-seeder/output apps/guided-repl/public/fixtures/v1
```

All must return **zero matches** (`apps/guided-repl/scripts/checkLessons.js`
runs an equivalent check automatically over the published fixture set).
Also confirm:

- Every written fixture passes `validateFixture` (the CLI already validates
  before writing — a failed validation aborts the run rather than writing
  a bad file).
- `l1-output/index.html` contains `<h1>`. If a run drifts (wrong filename,
  no `<h1>`), re-run that branch alone (`--branch constrained`) rather than
  hand-editing the fixture.
- Plan-file paths normalize to `~/.claude/plans/plan.md` (not the
  session-generated random filename) and workspace files normalize to
  bare relative paths (no leading `/`).
