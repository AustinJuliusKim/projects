# Worker Brief — guided-repl Lesson Foundry (v1)

Authoritative spec: `ObsidianVault/30-projects/Claude REPL Lesson Foundry Spec.md` (v1.3 LOCKED).
Related: `Claude REPL Lesson Engine Spec.md` (lesson schema), `Claude REPL Business Plan.md` (radar newsletter, cost model).
All paths below are repo-relative to this worktree root.

## Hard rules (embed in every task)

1. **Never full-auto publish — enforced structurally.** The pipeline's only write path to the
   repository is `gh pr create` from the workflow. No code anywhere in
   `services/guided-repl-foundry` may push to `main`, merge a PR, or call `gh pr merge`. A unit
   test (task 12) greps `foundry.yml` and the foundry CLI sources for forbidden operations.
   Publish = a human merging the PR. No exceptions, including scout notes/state.
2. **No secrets committed.** `ANTHROPIC_API_KEY` / `E2B_API_KEY` come only from GitHub repo
   secrets → env. Reuse the redaction patterns from `apps/guided-repl/scripts/checkLessons.js`
   (`sk-ant-`, emails, `/Users/`, UUIDs...) as a gate over everything the Foundry writes into a
   PR (notes, radar cards, fixtures, PR bodies).
3. **Keyless CI and tests.** Every network/model/sandbox boundary is injectable:
   `AgentClient` (Claude Agent SDK), `fetchImpl` (source fetchers), `Runner` (seeder), `gh`
   invocations. `node --test` must pass with no env vars set. NO live API calls in any
   verification command below.
4. **House style.** ESM (`"type": "module"`), plain JS + JSDoc types (no TypeScript), Node
   20.13, `node --test`, Zod for schema validation (matches protocol/lessons/seeder packages).
5. **Surgical diffs.** Existing packages are modified only where a task says so; extractions
   from `services/guided-repl-seeder/src/cli.js` must be behavior-preserving (existing tests
   keep passing unchanged).

---

## 1 · Architecture summary

Six-stage pipeline from the spec, mapped onto this repo:

```
foundry/sources.yaml ──► Scout (haiku, cadenced) ──► Topic Radar cards + source notes
                              │                            │
                              ▼                            ▼
                    overlap gate (self-corpus        radar/state PR
                    TF-IDF index over lessons/*.yaml)   [label foundry:radar]
                              │
              top-N within budget cap  ◄── admin hand-pick / idea box (workflow_dispatch)
                              ▼
                    Author (claude-fable-5 via Claude Agent SDK):
                    topic + freshly fetched primary sources + lesson schema digest
                    + l1.yaml few-shot exemplar + pedagogy + licensing rules ──► draft YAML
                              ▼
                    Lint (structural caps + optional LLM linter role)
                              ▼
                    Validate + seed: Zod (validateLessonDoc) → seed fixtures through the
                    EXISTING seeder path (E2B runner in CI, local runner on a dev box,
                    fake runner in tests) → compile staging tree → checkLessons-style gates
                    → assertions verified against the real recorded streams → cost report
                              ▼
                    Draft PR to packages/guided-repl-lessons + fixtures
                    [label foundry:draft, review card in PR body]  ──► human review/merge
```

- **Substrate:** GitHub Actions. Monthly cron = radar trigger; `workflow_dispatch` = idea box
  (thin ad-hoc trigger, an `idea` text input — the SPA "Foundry tab" is out of v1 scope, see
  reality-checks). Both run the same spine (`foundry run`), differing only in how the topic
  list is produced. Build order: shared spine first, then idea trigger, then radar trigger —
  the task order below follows this.
- **Review queue representation (v1):** open PRs labeled `foundry:draft`. Each PR body is the
  review card: provenance frontmatter `{role, model, cost, tokens}`, schema-pass, seed-pass,
  overlap score, why-now + sources, licensing/originality checklist, cost report, and local
  preview instructions (`npm run dev` in apps/guided-repl). `foundry queue` lists them via
  `gh pr list --label foundry:draft --json ...`.
- **Model routing:** `foundry/models.yaml` roles (scout=claude-haiku-4-5,
  author=claude-fable-5, linter/judge=claude-sonnet-4-6), per-run `--model-<role>` overrides.
  Runtime = `@anthropic-ai/claude-agent-sdk` (`query(prompt, options)`), wrapped by an
  injectable `AgentClient` so tests/CI never touch it.
- **Model Lab:** `foundry bench` CLI, role × model matrix over frozen golden sets in
  `foundry/bench/golden/`, thin custom harness (not promptfoo — decision rationale in §4).
  Metrics: schema-pass %, **seed-pass %** (reuses the validate+seed stage), judge pairwise
  rubric (judge fixed, never a contestant), $/draft, latency. Bench trigger: the
  `anthropic-news` registry source is tagged `benchTrigger: true`; when the scout sees a model
  announcement it emits a radar card of kind `bench` ("new model → run `foundry bench`") —
  bench itself stays manual (`workflow_dispatch` / local).
- **Budget:** `foundry/settings.yaml` — `topN: 3`, `budgetCapUsd: 10` per cadence run, overlap
  gate mandatory (`overlapThreshold`). Cost accounting from Agent SDK usage × a pricing table
  in settings; the run aborts authoring (and says so in the radar PR) when the projected
  spend would exceed the cap.

## 2 · Files

### New — `services/guided-repl-foundry/` (the service)

```
services/guided-repl-foundry/
  package.json                  # type:module; deps: @anthropic-ai/claude-agent-sdk, yaml, zod,
                                #   @guided-repl/protocol (file:../../packages/guided-repl-protocol),
                                #   @guided-repl/lessons  (file:../../packages/guided-repl-lessons);
                                #   bin: { "foundry": "./src/cli.js" }; scripts.test: "node --test"
  README.md                     # runbook: triggers, secrets, review flow, bench
  src/cli.js                    # foundry <run|scout|draft|bench|queue> [--mode radar|idea]
                                #   [--idea "<text>"] [--top-n N] [--dry-run] [--out <dir>]
                                #   [--runner local|e2b|fake] [--model-author <id>] ...
  src/config.js                 # load+Zod-validate foundry/{sources,models,settings}.yaml
  src/agent/agentClient.js      # createAgentClient({queryImpl}) → complete({role, system,
                                #   prompt, model}) → {text, usage, costUsd}; default queryImpl
                                #   = Agent SDK query(); tests inject a fake
  src/agent/pricing.js          # usage → USD from settings.pricing table
  src/sources/fetchers.js       # githubReleases / githubCommits / rss / htmlList fetchers,
                                #   all over an injected fetchImpl; per-source failure isolation
  src/scout/scout.js            # per-source delta since cursor → haiku summary → source note
                                #   markdown + radar card {topic, whyNow, sources[],
                                #   overlapScore, suggestedTrack, kind: "lesson"|"bench"}
  src/scout/cursors.js          # read/write foundry/state/cursors.json (content-hash dedupe;
                                #   idempotent if the state PR wasn't merged)
  src/overlap/lessonIndex.js    # TF-IDF/cosine index over packages/guided-repl-lessons/lessons
                                #   /*.yaml (titles, instruction/annotation/quiz md) — the
                                #   spec's "retrieval scoped to self-knowledge only"; no deps,
                                #   no embeddings (keyless CI)
  src/author/promptPack.js      # assembles the fixed block (schema digest from lessonSchema,
                                #   l1.yaml exemplar verbatim, pedagogy principles: ≤5min, ≤3
                                #   branches, one assertion, counterfactual pedagogy; licensing
                                #   rule: registry courses are radar not raw material, original
                                #   expression, primary-source grounding) + per-topic block
                                #   (topic, whyNow, fetched primary sources)
  src/author/author.js          # AgentClient call (role author) → extract YAML → parse; retry
                                #   once on parse failure with the error appended
  src/lint/lessonLint.js        # structural caps (durationTargetSec ≤ 330, run branches ≤ 3,
                                #   exactly one assertion step, completion refs valid) +
                                #   optional LLM linter (role linter) behind --llm-lint
  src/validate/validateDraft.js # validateLessonDoc (protocol Zod) → lessonLint → seed via
                                #   seeder seedLib (injected Runner) → compile a staging tree
                                #   (existing lessons + draft) with --lessons-dir/--fixtures-
                                #   root → anchor resolution + suggestion/branch coverage +
                                #   redaction grep → {schemaPass, seedPass, report}
  src/pr/draftBundle.js         # writes the PR working set to an out dir: lesson YAML,
                                #   fixtures/snapshots, recompiled lessons.json, PR body md
                                #   (review card + provenance frontmatter), branch name,
                                #   labels. NO git operations here.
  src/pr/queue.js               # `foundry queue` — list foundry:draft PRs via injected gh exec
  src/radar/radarBundle.js      # radar/state PR working set: foundry/notes/YYYY-MM/*.md,
                                #   updated cursors.json, radar.md card summary
  src/bench/bench.js            # role×model matrix over golden sets; scorecard md+json into
                                #   foundry/bench/results/; judge = pairwise, fixed model
  src/bench/judges.js
  test/                         # *.test.js per module + e2e.test.js (full dry-run with fakes)
  test/fakes/                   # fakeAgent.js, fakeFetch.js (recorded source payloads),
                                #   fakeRunner.js (canned NDJSON stream), fakeGh.js
  test/fixtures/                # recorded RSS/GitHub API payloads, canned author YAML output
```

### New — `foundry/` (repo-root config dir, per spec)

```
foundry/sources.yaml     # registry, launch set (6 = 5 content + bench trigger):
                         #   claude-code-releases  (githubReleases anthropics/claude-code)
                         #   anthropic-academy     (htmlList catalog page; scrape-lite, isolated)
                         #   mcp-spec              (githubCommits modelcontextprotocol/modelcontextprotocol)
                         #   genai-for-beginners   (githubCommits microsoft/generative-ai-for-beginners)
                         #   hf-blog               (rss https://huggingface.co/blog/feed.xml)
                         #   anthropic-news        (rss; benchTrigger: true)
                         # per-source: {id, method, url/repo, cadence, benchTrigger?}
foundry/models.yaml      # roles: scout claude-haiku-4-5 · author claude-fable-5 (bench
                         # candidate claude-opus-4-8) · linter claude-sonnet-4-6 (candidate
                         # claude-sonnet-5) · judge claude-sonnet-4-6 (never a contestant);
                         # `provider` field reserved, v1 = anthropic
foundry/settings.yaml    # topN: 3, budgetCapUsd: 10, overlapThreshold: 0.65, labels
                         # (foundry:draft, foundry:radar), branchPrefix foundry/, pricing
                         # table ($/MTok in+out per model id)
foundry/state/cursors.json
foundry/notes/.gitkeep           # scout source-notes store (institutional memory, RAG-lite)
foundry/bench/golden/author/     # 3–5 frozen topic briefs (md, with frozen source packs)
foundry/bench/golden/scout/      # hand-labeled source-delta snapshots (json)
foundry/bench/results/.gitkeep
```

### Modified (surgical)

- `services/guided-repl-seeder/src/cli.js` — extract reusable internals; CLI behavior unchanged.
- `services/guided-repl-seeder/src/seedLib.js` (new) — exported `collectPacedEvents`,
  `runSegment`, `makeSeedWorkspace`, `getClaudeCodeVersion` etc., all taking an injected
  `runner` + optional `versionProvider`.
- `services/guided-repl-seeder/src/docRecipe.js` (new) — synthesize a simple recipe from a
  compiled lesson doc (each run-step branch → one `claude -p` segment; v1 supports `simple`
  and `plan` kinds only).
- `services/guided-repl-seeder/src/runner/e2bRunner.js` — replace the stub with a real E2B
  implementation (injected sandbox factory; live path uses the `e2b` SDK + a template with the
  `claude` CLI preinstalled; reports `claude --version` from inside the sandbox).
- `packages/guided-repl-lessons/src/compile.js` — add `--lessons-dir <dir>` flag + export the
  equivalent option on `compileAll` so the Foundry can compile a staging tree.
- `apps/guided-repl/scripts/checkLessons.js` — derive the snapshot CHAIN from the manifest
  instead of the hardcoded `["l1","l3",...]` list, and treat lessons whose seed snapshot is
  self-contained (Foundry drafts, `track: advanced`) as chain roots.
- `.github/workflows/guided-repl.yml` — add `foundry` test job (keyless `npm test`) + add
  `services/guided-repl-foundry/**` and `foundry/**` to both path filters.
- `.github/workflows/foundry.yml` (new) — the pipeline workflow (see task 12).

## 3 · Ordered tasks

Each task ends with a local verification command. None may require API keys, network, the
`claude` CLI, or E2B. Where a package has `file:` links, run `npm ci` once in
`packages/guided-repl-protocol` (and `packages/guided-repl-lessons` for the foundry pkg) first
— same pattern the existing CI uses.

**Task 1 — Scaffold package + config dir + config loader.**
Create `services/guided-repl-foundry` (package.json, README stub) and the `foundry/` dir with
the three YAML files, state, notes, bench skeleton exactly as in §2. `src/config.js` loads and
Zod-validates all three (unknown roles/sources → hard error; every model id referenced in
models.yaml must exist in settings.pricing). Tests validate the real committed YAML files plus
rejection cases.
Verify: `cd services/guided-repl-foundry && npm ci && node --test test/config.test.js`

**Task 2 — Agent boundary + pricing.**
`src/agent/agentClient.js` with `createAgentClient({queryImpl, models, pricing})`. Default
`queryImpl` lazily imports `@anthropic-ai/claude-agent-sdk` and drives `query()` with
`allowedTools: []` (sources are context-stuffed, the author agent needs no tools) and the
role's model; collects final text + usage. Fake in `test/fakes/fakeAgent.js` records prompts
and returns canned text/usage. `pricing.js` converts usage → USD. Tests: role→model routing,
per-run override, cost math, and that constructing the client performs no network I/O.
Verify: `cd services/guided-repl-foundry && node --test test/agentClient.test.js`

**Task 3 — Lesson index + overlap gate.**
`src/overlap/lessonIndex.js`: parse `packages/guided-repl-lessons/lessons/*.yaml`, build
TF-IDF vectors from title/instruction/annotation/quiz text, `overlapScore(topicText)` → [0,1]
plus nearest lesson id ("which lesson covers X"). Gate: `overlapScore >= overlapThreshold` →
rejected with reason. Tests use the real l1–l8 corpus: "ship a landing page with Claude Code"
must gate out; a genuinely novel topic (e.g. "evaluating RAG retrieval quality") must pass.
Verify: `cd services/guided-repl-foundry && node --test test/lessonIndex.test.js`

**Task 4 — Source fetchers + scout + cursors (radar's raw material; spine still first-class).**
`src/sources/fetchers.js` (all over injected `fetchImpl`; GitHub via public REST, no auth
token required at the volumes involved — accept an optional `GITHUB_TOKEN` for rate headroom).
`src/scout/scout.js`: per source, fetch delta since cursor → one haiku call (role scout) →
source-note markdown + zero-or-more radar cards; `benchTrigger` sources emit `kind: "bench"`
cards. Per-source try/catch: one dead feed degrades, never kills the run. `cursors.js`
content-hash dedupe makes re-runs idempotent when the previous state PR is unmerged. Redaction
grep over all emitted markdown. Tests: recorded payloads in `test/fixtures/`, fake agent.
Verify: `cd services/guided-repl-foundry && node --test test/scout.test.js test/fetchers.test.js`

**Task 5 — Author stage.**
`src/author/promptPack.js` + `author.js` per §2. The fixed block is byte-stable across topics
within a run (deliberate: prompt-cache-friendly, and the bench harness freezes it). Extract
the YAML from the response (fenced block), parse with `yaml`, attach provenance
`{role, model, costUsd, tokens}`. One retry on parse/Zod failure with the error message
appended to the prompt. Tests: fake agent returning (a) valid lesson YAML, (b) garbage then
valid on retry; assert the pack embeds l1.yaml verbatim and the licensing rule text.
Verify: `cd services/guided-repl-foundry && node --test test/author.test.js`

**Task 6 — Lint stage.**
`src/lint/lessonLint.js` structural caps (see §2) as pure functions over a parsed lesson doc;
optional LLM pass behind a flag (role linter, fake in tests). Caps are hard failures with
precise messages (they feed the review card).
Verify: `cd services/guided-repl-foundry && node --test test/lessonLint.test.js`

**Task 7 — Seeder extraction + doc-driven recipes (behavior-preserving).**
Create `seedLib.js` by moving `collectPacedEvents`, `runSegment`, `makeSeedWorkspace`,
`getClaudeCodeVersion`, snapshot/write helpers out of `cli.js`; `cli.js` imports them —
identical CLI behavior, `runner` and `versionProvider` become injectable parameters with the
current defaults. Add `docRecipe.js`: given a compiled lesson doc + seed snapshot, produce
branch segments (branch permissionMode/expectedPrompt from the lesson's run step; `plan`
branches get the existing authorGate treatment). Existing seeder tests must pass unedited; new
tests drive `docRecipe` + `seedLib` with a fake runner emitting canned NDJSON events and
assert fixtures round-trip through `validateFixture`.
Verify: `cd services/guided-repl-seeder && npm test`

**Task 8 — Real E2B runner.**
Rewrite `src/runner/e2bRunner.js`: `createE2bRunner({sandboxFactory})` implementing the
`Runner` interface — create sandbox from template `guided-repl-seeder`, write workspace files,
run `claude -p <prompt> --output-format stream-json --permission-mode <mode>`, yield parsed
NDJSON lines, expose `getVersion()` (runs `claude --version` in-sandbox), teardown on
completion/error. The `e2b` dependency is imported lazily inside the default factory so tests
(injected fake sandbox) and CI stay keyless. Document the template requirements in the seeder
README (claude CLI on PATH, node, ANTHROPIC_API_KEY passed as sandbox env).
Verify: `cd services/guided-repl-seeder && node --test test/e2bRunner.test.js`

**Task 9 — Compile `--lessons-dir` + checkLessons chain generalization.**
`compile.js`: accept `--lessons-dir` (and an options arg on `compileAll`) defaulting to the
current path; no other behavior change. `checkLessons.js`: build the chain from manifest
`snapshot.snapshotId` references (a lesson whose seed snapshot is produced by no other lesson
and matches `<id>-input` is a root — l1 and Foundry drafts both qualify); keep every existing
check. Both packages' tests + the drift/consistency gates must stay green against the
committed content.
Verify: `cd packages/guided-repl-lessons && npm test && npm run build && npm run check && cd ../../apps/guided-repl && npm run check:lessons`

**Task 10 — Validate+seed stage, draft/radar bundles, queue.**
`validateDraft.js` wires tasks 5–9 together: Zod → lint → seed (injected runner) → staging
compile (`--lessons-dir` staging tree containing committed lessons + draft, `--fixtures-root`
staging fixtures) → anchor/coverage checks → redaction grep → `{schemaPass, seedPass, report}`.
`draftBundle.js` / `radarBundle.js` write complete PR working sets to an out dir (files + PR
body + branch name + labels) — **no git**. `queue.js` shells `gh pr list` through an injected
exec. Tests: full validate over a canned draft with the fake runner; bundle snapshot tests;
assert the PR body contains provenance frontmatter, seed-pass %, cost report, and the
originality checklist; assert no bundle file trips the redaction patterns.
Verify: `cd services/guided-repl-foundry && node --test test/validateDraft.test.js test/bundles.test.js`

**Task 11 — CLI wiring + end-to-end dry run (spine complete; idea + radar triggers).**
`src/cli.js` subcommands per §2. `foundry run --mode radar`: scout → gate → budget-capped
top-N author → validate/seed → one draft bundle per topic + one radar bundle.
`foundry run --mode idea --idea "..."`: skips scout, single topic, same spine (idea box =
thin ad-hoc trigger). `--dry-run` uses fakes end-to-end and writes bundles to `--out`.
`e2e.test.js`: run both modes with all fakes; assert bundle layout, budget-cap abort behavior
(3rd topic skipped when projected cost > cap), overlap-gate rejection recorded in the radar
bundle, and exit codes.
Verify: `cd services/guided-repl-foundry && npm test`

**Task 12 — Bench harness (`foundry bench`).**
`bench.js`: `foundry bench --role author --models claude-fable-5,claude-opus-4-8` runs each
golden brief through the author stage per model (frozen source packs from
`foundry/bench/golden/` — never live-fetched), scores schema-pass %, seed-pass % (via
`validateDraft` with the provided runner; `--no-seed` skips), judge pairwise comparisons
(judge model fixed from models.yaml; error if a contestant equals the judge), $/draft,
latency; writes `foundry/bench/results/<date>-<role>.md` + `.json`. Scout benching scores
topic recall/precision against the labeled snapshots. Seed 3 author golden briefs + 1 labeled
scout snapshot as committed fixtures. Tests with fake agent + fake runner.
Verify: `cd services/guided-repl-foundry && node --test test/bench.test.js`

**Task 13 — Workflows + structural-invariant guard.**
`.github/workflows/foundry.yml`:
- `on: schedule: [{cron: "0 14 1 * *"}]` (monthly, spec default) + `workflow_dispatch` with
  inputs `{mode: choice[radar,idea,bench], idea: string, top_n: string, models: string}`.
- Single job: checkout; setup-node 20.13; `npm ci` in protocol, lessons, seeder, foundry;
  guard step that exits 0 with a notice when `ANTHROPIC_API_KEY`/`E2B_API_KEY` secrets are
  absent (cron is safe to merge before secrets exist); run
  `node services/guided-repl-foundry/src/cli.js run --mode ${{...}} --runner e2b --out /tmp/foundry-out`;
  then for each bundle: `git switch -c <branch>`, copy files, commit, `git push origin <branch>`,
  `gh pr create --draft --label ... --body-file ...`. `permissions: {contents: write,
  pull-requests: write}`; `concurrency: {group: foundry, cancel-in-progress: false}`.
- **Never any push to `main`, never `gh pr merge`.**
Modify `guided-repl.yml` per §2 (foundry test job + path filters). Add
`test/workflowGuard.test.js` in the foundry package: parse both workflow files with `yaml`,
assert foundry.yml has no `gh pr merge`, no `git push origin main`/`HEAD:main`, correct
permissions block, and that the cron matches settings.yaml cadence.
Verify: `cd services/guided-repl-foundry && node --test test/workflowGuard.test.js && npx --yes js-yaml ../../.github/workflows/foundry.yml > /dev/null`

**Task 14 — README/runbook + final sweep.**
Finish `services/guided-repl-foundry/README.md`: trigger matrix, review-queue workflow
(labels → review card → merge → existing guided-repl.yml CI deploys), bench runbook, E2B
template setup, manual-ops list (§5), cost model summary. Run the full-repo verification.
Verify: `for d in packages/guided-repl-protocol packages/guided-repl-lessons services/guided-repl-seeder services/guided-repl-foundry; do (cd $d && npm test) || exit 1; done && cd apps/guided-repl && npm run check:lessons`

## 4 · Conflicts / reality-checks vs the spec

1. **Package name:** spec says PRs target `packages/claude-repl-lessons`; the repo package is
   `packages/guided-repl-lessons`. Use the real path everywhere; note it when syncing vault docs.
2. **E2B runner is a stub today** (`e2bRunner.js` throws "not configured"), yet the locked
   substrate says "seeding runs call E2B". Task 8 makes it real; an E2B account + a template
   with the `claude` CLI preinstalled is a manual op. Until then, seeding only works locally
   (`--runner local`) and the workflow's guard step skips gracefully.
3. **`claudeCodeVersion` capture:** seeder currently shells local `claude --version`; in CI
   the version must come from inside the E2B sandbox (task 7/8 `versionProvider`).
4. **Seeder is recipe-hardcoded (l1 special-cased, l2–l8 in `recipes/`, CHAIN_ORDER fixed).**
   Foundry drafts have no hand-written recipe, so v1 drafts are constrained to what
   `docRecipe.js` can synthesize: `simple` and `plan` branch kinds, self-contained seed
   snapshot, `track: advanced`. `multiplan`/`merge`-style lessons remain human-authored. Encode
   this constraint in the author prompt.
5. **`checkLessons.js` CHAIN and l7 special cases are hardcoded** — task 9 generalizes; do not
   silently drop any existing check.
6. **Admin UI "Foundry tab"** (idea box streaming UI, cadence config UI, embedded preview) is
   larger than the GitHub-Actions substrate and is NOT in v1. The locked v1 scope is "both
   features, one spine" where idea box = thin ad-hoc trigger — satisfied by
   `workflow_dispatch --mode idea` + local CLI. Review queue = labeled PRs + `foundry queue`.
   The SPA tab is a follow-up milestone.
7. **Bench economics (Batch API + prompt caching):** the Claude **Agent SDK has no Batch API**;
   batching lives in the plain `@anthropic-ai/sdk` (`messages.batches`, 50% off). v1 bench
   runs synchronous Agent SDK sweeps at small n (3–5 briefs × 2–3 models — cost fine); if/when
   sweeps grow, add a batch path via the plain SDK behind the same `AgentClient` boundary.
   Spec explicitly defers runner tooling to build time; also skip promptfoo (its assertion
   model doesn't reach our seed-validation-as-metric; a thin harness reusing `validateDraft`
   is smaller than the adapter would be).
8. **Scout notes/cursors as PRs:** because *everything* is PR-only, the cursors file on `main`
   can lag if radar PRs sit unmerged. Task 4's content-hash dedupe makes reruns idempotent, at
   the cost of some re-summarization. Acceptable at monthly cadence; revisit at weekly.
9. **PRs created with `GITHUB_TOKEN` do not trigger `pull_request` workflows** (GitHub
   anti-recursion rule) — draft PRs won't get guided-repl CI automatically. Options: a
   fine-grained PAT / GitHub App token in a `FOUNDRY_PR_TOKEN` secret for `gh pr create`, or
   the reviewer closes/reopens (or pushes) to trigger CI. Default the workflow to
   `FOUNDRY_PR_TOKEN` when present, falling back to `GITHUB_TOKEN` with a warning in the PR body.
10. **Anthropic Academy catalog has no feed** — the `htmlList` fetcher is the one scrape-lite
    exception to "feeds and git over scraping". It is failure-isolated; if it proves brittle,
    prune it (registry is 3–5 sources, spec allows dropping to 5 content sources → 4).
11. **Provenance placement:** lesson YAML must stay clean against the protocol Zod schema, so
    provenance lives in the PR body frontmatter + the bundle's `provenance.json`, not inside
    the lesson file. Matches spec ("every draft PR carries provenance frontmatter").
12. **Model ids** in models.yaml (`claude-fable-5`, `claude-haiku-4-5`, `claude-sonnet-4-6`,
    bench candidates `claude-opus-4-8`, `claude-sonnet-5`) verified current as of 2026-07.

## 5 · Manual ops (humans, not the worker)

- **Repo secrets:** `ANTHROPIC_API_KEY`, `E2B_API_KEY`; recommended `FOUNDRY_PR_TOKEN`
  (fine-grained PAT: contents write + pull-requests write) so draft PRs trigger CI (§4.9).
- **E2B:** create account; build sandbox template `guided-repl-seeder` (node 20, `claude` CLI
  on PATH); verify one live `seed-lessons l1 --runner e2b` supervised run.
- **Enable the cron:** merges of `foundry.yml` to the default branch arm the schedule; note
  GitHub auto-disables schedules after ~60 days of repo inactivity — re-enable from the
  Actions tab if the repo goes quiet.
- **Repo settings:** Actions → "Allow GitHub Actions to create and approve pull requests" ON;
  branch protection on `main` requiring PR review (this is the structural backstop for the
  never-full-auto-publish invariant); create labels `foundry:draft`, `foundry:radar`.
- **Registry review:** sources are a permanent maintenance surface — review
  `foundry/sources.yaml` at each cadence review; add slowly, prune rarely; watch the
  anthropic-academy scraper first (§4.10).
- **First cadence run supervised:** trigger `workflow_dispatch --mode idea` with a known topic
  before trusting the monthly cron; review the first radar PR's notes for redaction misses.
- **Review checklist per draft PR:** originality pass (licensing rules), pedagogy sanity,
  seed-pass report, then merge → existing guided-repl CI validates + deploys. Record
  merged-as-is / edited / rejected in the PR labels — this is the bench telemetry.
