# guided-repl-foundry

Lesson Foundry: the admin-facing agentic pipeline that watches the
AI-education landscape, proposes lesson topics on a cadence, and drafts
publish-ready lesson YAML — delivered as **draft PRs**. Publish is always a
human merging the PR. **Never full-auto publish** is structural: nothing in
this package or its workflow can push to `main` or merge a PR
(`test/workflowGuard.test.js` enforces it).

Spec: `ObsidianVault/30-projects/Claude REPL Lesson Foundry Spec.md` (v1.3 LOCKED).
Note: the spec says PRs target `packages/claude-repl-lessons`; the real repo
path is `packages/guided-repl-lessons` and is used everywhere here.

## Pipeline

```
foundry/sources.yaml → scout (haiku) → notes + Topic Radar cards
                                        │ overlap gate (TF-IDF over our own l1–l8)
                                        │ top-N within budgetCapUsd
                                        ▼
                       author (claude-fable-5, Agent SDK, no tools)
                                        ▼
                       lint (structural caps) → validate+seed (Zod → seeder
                       path with E2B/local/fake Runner → staging compile →
                       assertions verified on real runs → redaction grep)
                                        ▼
                       draft PR bundle [foundry:draft] + radar/state PR
                       [foundry:radar]  →  HUMAN REVIEW → merge = publish
```

## Trigger matrix

| trigger | how | what runs |
| --- | --- | --- |
| Monthly cadence | `foundry.yml` cron `0 14 1 * *` (== `settings.cadenceCron`) | `foundry run --mode radar --runner e2b` |
| Idea box | Actions → foundry → Run workflow → mode `idea` + idea text | `foundry run --mode idea --idea "..."` |
| Bench | Actions → mode `bench` (+ models), or locally | `foundry bench --role author ...` |
| Local dev | `node src/cli.js run --mode idea --idea "..." --dry-run --out /tmp/f` | full spine on built-in fakes, zero keys |

CLI: `foundry <run|scout|draft|bench|queue>` — `--mode radar|idea`,
`--idea "<text>"`, `--top-n N`, `--dry-run`, `--out <dir>`,
`--runner local|e2b`, `--model-<role> <id>`, `--llm-lint`,
`--role <role> --models a,b --no-seed` (bench).

## Review queue workflow

1. The pipeline opens **draft PRs** labeled `foundry:draft` (lesson YAML +
   fixtures + snapshots + recompiled `lessons.json`), each with a review
   card in the body: provenance frontmatter `{role, model, cost, tokens}`,
   schema/seed/compile/redaction results, overlap score, why-now + sources,
   licensing/originality checklist, cost report, local preview instructions.
2. `foundry queue` lists them (`gh pr list --label foundry:draft`).
3. Review: originality pass (licensing rules), pedagogy sanity, seed report.
   Edit in place if needed. **Merging is the publish action** — the existing
   `guided-repl.yml` CI validates (checkLessons drift/redaction gates) and
   deploys.
4. Record the outcome (merged-as-is / edited / rejected) via PR labels —
   this is the production telemetry the Model Lab reads.
5. Radar/state PRs (`foundry:radar`) carry scout notes, the radar decision
   table, and updated `foundry/state/cursors.json`. Merge to keep
   institutional memory; cursors are content-hash-deduped so an unmerged
   state PR only costs re-summarization, never duplicate drafts.

## Bench runbook (Model Lab)

- Trigger: when a `benchTrigger` source (anthropic-news) surfaces a model
  announcement, the radar emits a `bench` card — bench itself stays manual.
- `foundry bench --role author --models claude-fable-5,claude-opus-4-8`
  runs each frozen golden brief (`foundry/bench/golden/author/*.md` — never
  live-fetched; edit only by ADDING briefs) through the author stage per
  model. Metrics: schema-pass %, **seed-pass %** (reuses validateDraft;
  `--no-seed` skips), pairwise judge wins (judge fixed from models.yaml,
  never a contestant — enforced), $/draft, latency.
- `--role scout` scores topic recall/precision against the hand-labeled
  snapshots in `foundry/bench/golden/scout/`.
- Scorecards land in `foundry/bench/results/<date>-<role>.{md,json}`; the
  CI bench mode PRs them under `foundry:radar`.
- Sweeps are synchronous Agent SDK calls at small n (3 briefs × 2–3
  models). If sweeps grow, add a Batch API path (plain `@anthropic-ai/sdk`,
  50% off) behind the same AgentClient boundary.

## Config (`foundry/` at the repo root)

- `sources.yaml` — registry (5 content sources + `anthropic-news` bench
  trigger). Permanent maintenance surface: add slowly, prune rarely.
- `models.yaml` — role routing: scout=haiku-4-5, author=fable-5,
  linter/judge=sonnet-4-6. Per-run override: `--model-<role>`.
- `settings.yaml` — `topN: 3`, `budgetCapUsd: 10`, `overlapThreshold: 0.65`,
  labels, branch prefix, `cadenceCron`, pricing table ($/MTok). Every model
  referenced in models.yaml must have a pricing entry (config.js enforces).

## Cost model (monthly cadence defaults)

- Scout: 6 haiku calls ≈ cents.
- Author: top-3 × fable-5 ≈ $1–3/draft at typical prompt sizes (the fixed
  block is byte-stable per run → prompt-cache friendly).
- Hard cap: the run aborts authoring (and says so in the radar PR) when
  `spent + per-draft estimate > budgetCapUsd` ($10 default). Dial the
  cadence toward weekly only as review bandwidth justifies.

## E2B template setup

The seeder's E2B runner (`services/guided-repl-seeder/src/runner/e2bRunner.js`)
expects a published sandbox template **`guided-repl-seeder`**:

- node 20+, `claude` CLI on PATH (`npm i -g @anthropic-ai/claude-code`),
  writable `/home/user/workspace`.
- `E2B_API_KEY` (SDK) and `ANTHROPIC_API_KEY` (passed into the sandbox) in
  the workflow secrets.
- Fixture stamps use `claude --version` from INSIDE the sandbox.
- Verify with one supervised `seed-lessons l1 --runner e2b`-style run before
  trusting CI (see the seeder README).

## Manual ops (humans, not the pipeline)

- Repo secrets: `ANTHROPIC_API_KEY`, `E2B_API_KEY`; recommended
  `FOUNDRY_PR_TOKEN` (fine-grained PAT, contents+PR write) so draft PRs
  trigger CI — plain GITHUB_TOKEN PRs need a close/reopen (the PR body warns).
- Repo settings: Actions → "Allow GitHub Actions to create and approve pull
  requests" ON; branch protection on `main` requiring review (the structural
  backstop); create labels `foundry:draft`, `foundry:radar`.
- E2B: account + the template above.
- Enable the cron by merging `foundry.yml` to the default branch; GitHub
  auto-disables schedules after ~60 days of repo inactivity — re-enable from
  the Actions tab.
- **Verify the `anthropic-news` RSS URL** in `foundry/sources.yaml`
  (`https://www.anthropic.com/news/rss.xml` is plausible but unverified —
  a wrong URL degrades gracefully but silences the bench trigger). Check on
  the first supervised run.
- First cadence run supervised: `workflow_dispatch` mode `idea` with a known
  topic; inspect the first radar PR's notes for redaction misses.
- Registry review each cadence: watch the `anthropic-academy` scraper first;
  the registry may drop to 4 content sources if it proves brittle.

## Tests

```
npm ci    # plus npm ci in packages/guided-repl-protocol, packages/guided-repl-lessons,
          # and services/guided-repl-seeder (file:-linked)
npm test
```

Keyless by construction: AgentClient (Agent SDK), fetchers, Runner (seeder),
and `gh` are all injectable; `node --test` passes with no env vars, no
network, no `claude` CLI, no E2B. The full local matrix:

```
for d in packages/guided-repl-protocol packages/guided-repl-lessons \
         services/guided-repl-seeder services/guided-repl-foundry; do
  (cd $d && npm test) || break
done
cd apps/guided-repl && npm run check:lessons
```
