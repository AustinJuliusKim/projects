# guided-repl-seeder

CLI that records real Claude Code agent runs for each Guided REPL lesson
branch and writes them out as fixtures (`@guided-repl/protocol` fixture
format) for the `apps/guided-repl` fixture player.

## Usage

```
npm install
node src/cli.js <l1|all|l2..l8> [--branch <id>] [--out <dir>]
```

Runs each branch of the lesson live via the local `claude` CLI (headless
`claude -p ... --output-format stream-json`) in a throwaway tmp workspace,
maps the raw stream to protocol frames, normalizes/redacts, snapshots the
workspace, and writes `fixtures/<lessonId>/<branchId>.json` +
`snapshots/<id>.json` to `output/<version>/`, then publishes them into
`apps/guided-repl/public/fixtures/<version>/`. See `RECORDER.md` for the
full recording workflow, the plan-mode two-pass splice, and the redaction
checklist.

`l1` is recorded standalone. `l2`-`l8` are driven by the recipe registry
(`src/recipes/`) and chain off each other's output snapshot — `all` records
them in that order (`src/recipes/index.js`'s `CHAIN_ORDER`).

## Recipe system

Each lesson beyond L1 has a recording recipe under `src/recipes/` (content
— prompts, quiz, assertions — stays in `lessons.json`; the recipe only
carries recording instructions). A recipe's `branches` map each branch to a
`kind`:

- `simple` — one run at a given `permissionMode`.
- `plan` — a `plan`-mode run followed by an `acceptEdits` execution run in
  the same workspace, spliced by `applyAuthorGate` (thin wrapper over
  `applyMultiPlanGate`, see below).
- `multiplan` — an arbitrary chain of plan/exec segments (e.g. L4's
  `revise` branch: plan → revised plan → exec), spliced by
  `applyMultiPlanGate` with one gate (`awaitClient` + synthesized
  `permission_request`) between each pair of segments.
- `model` — a `simple` run pinned to an explicit `model` id (L8's
  haiku/sonnet comparison).

A recipe also carries `seedFrom` (the source snapshot id) and
`outputBranch` (which branch's post-run workspace becomes
`<lessonId>-output`, the seed for the next lesson in the chain). Branches
can layer `extraFiles` onto the seeded workspace (e.g. L7's `with` branch
adds a `CLAUDE.md`) and can request a named `snapshotId` capture of their
own pristine input (L7's `l7-input-plain`/`l7-input-claudemd`).

L2 is the one exception: it's a `kind: "merge"` recipe with no live run —
see "L2: annotation merge" below.

## Chain-order seeding

`seedRecipeLesson` seeds each branch's workspace from the recipe's
`seedFrom` snapshot (published under `apps/guided-repl/public/fixtures/v1/
snapshots/`, so `--out` doesn't affect where prior-lesson snapshots are
read from), runs the branch, and snapshots the `outputBranch`'s resulting
workspace as `<lessonId>-output` for the next lesson to seed from. This is
why lessons must be recorded in chain order the first time
(`l1 -> l3 -> l4 -> l5 -> l6 -> l7 -> l8`, with `l7` also branching into
per-input `l7-input-plain`/`l7-input-claudemd` snapshots) — `all` does this
automatically.

## Model recording

`modelStamp.js` captures the real model id off the live stream's
`system/init` event and stamps it onto every `usage` frame's
`payload.model` — recipes never hardcode a model id into a fixture, only
into the recipe's `model` field for `kind: "model"` branches (which is
passed to the `claude -p` invocation, not written directly to the fixture).

## L2: annotation merge

L2 ("Why did it do that?") is a step-through replay of L1's `constrained`
run, not a new recording. `seedMergeLesson` copies that fixture and calls
`annotationMerge.js`'s `mergeAnnotations` to attach hand-authored
`{title, body}` annotations to specific event indices, then rewrites the
copy's `lessonId`/`branchId`.

## Modules

- `src/cli.js` — `seed-lessons` entry point, `seedLessonOne` (l1),
  `seedRecipeLesson` (l2-l8, recipe-driven), and per-branch orchestration.
- `src/recipes/` — one file per lesson (l2-l8) plus `index.js`'s registry
  and `CHAIN_ORDER`.
- `src/runner/localRunner.js` — spawns `claude -p` in a tmp workspace
  (hard-guarded against running inside the repo); `runner.js` documents the
  `Runner` interface; `e2bRunner.js` is a stub for a future sandboxed runner.
- `src/streamMapper.js` — raw stream-json NDJSON → protocol `ServerMsg` frames.
- `src/normalizer.js` — redaction (paths, usernames, display names, emails,
  UUIDs, key-shaped strings); fixtures ship publicly.
- `src/pacing.js` — compressed `delayMs` + retained `origDelayMs`.
- `src/snapshotter.js` — workspace FS → snapshot manifest (contents sanitized).
- `src/workspace.js` — tmp workspace construction: bare starter (l1) or
  materialized from a prior lesson's output snapshot, plus branch `extraFiles`.
- `src/authorGate.js` — `applyMultiPlanGate` (general plan/exec segment
  splicer) and `applyAuthorGate` (its 2-segment plan-mode wrapper): both
  synthesize the `permission_request` frame + `awaitClient` gate between
  segments.
- `src/modelStamp.js` — captures the live-stream model id and stamps it
  onto `usage` frames.
- `src/annotationMerge.js` — L2's fixture-copy + annotation-attach merge.
- `src/fixtureWriter.js` — envelope assembly + validation + write.

## Test

```
npm test
```

Tests run against captured raw stream fixtures in `test/fixtures/raw/` and
never invoke the live `claude` CLI (CI-safe).
