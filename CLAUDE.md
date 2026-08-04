# CLAUDE.md

## Repo shape

A monorepo of independently deployed pieces: `apps/` (choices-webapp, guided-repl, portfolio), `packages/` (shared libraries), `services/` (Lambda/API backends), `ops/` (CloudFormation for alarms, dashboards, canaries), `foundry/`, `mtg-tools/` (a self-contained MTG collection tool — stdlib-only library + Flask API + React/Mantine SPA — imported from a standalone repo with its own `CLAUDE.md` and conventions intact; deploys to Cloudflare Pages, not AWS).

There is no workspace root. Each area owns its own `package.json`, deploy workflow, and cloud stack (AWS for everything except `mtg-tools/`, which is Cloudflare) — `cd` into the area you're working in and run its scripts there. Each area's workflow runs `npm ci` plus whichever of `test`, `build`, and `check` that area actually has; several areas have no `build` script and `apps/portfolio` has no `test`.

Don't create an `ARCHITECTURE.md`. Repo conventions live here and project decisions live in the vault; a third source would immediately drift.

- Tests use Node's built-in runner (`node --test`). Don't introduce a second framework.
- React apps use React `^19` — don't start a new app on an older major. The caret keeps each app on 19.x without drifting to a future major.
- `npm run check` exists in some areas (e.g. `packages/guided-repl-lessons`).
- `apps/portfolio` is build-only and has no test script by design — its absence is not a gap.
- Don't run deploy scripts, `bootstrap-infra.sh`, or `services/mtg-api`'s
  Makefile admin/deploy targets (`make deploy`, `make deploy-bootstrap`,
  `make embed`, `make eval-similar`, `make eval-calibration`) — these
  mutate real AWS/Supabase resources.

## ObsidianVault

Before starting work on any task in this repo, scan the vault for notes related to the topic — grep by keyword rather than reading it whole. Index is `10-maps/Projects MOC.md`; per-project plans are in `30-projects/`.

The vault holds locked decisions and roadmaps that override assumptions drawn from code alone — `30-projects/Choices Growth Plan.md` governs choices-webapp, for example. If the work would change something a note documents, say so rather than quietly diverging.

Resolve the vault location in this order:

1. `/Users/aukim/personal/ObsidianVault/` — the source of truth, always current.
2. `./ObsidianVault/` — in-repo submodule, for CI or remote sessions where the absolute path doesn't resolve. Pinned to a commit and possibly stale; run `git submodule update --init ObsidianVault` first.

Run `/vault-sync` before shipping work that changed `apps/`, `packages/`, or `services/`.

## Agents

`.claude/agents/` holds `architect` (fable), `developer` (sonnet), `code-reviewer` (opus), `repo-scout` (sonnet). Routing is the cheapest model that does the job. `code-reviewer` is on Opus because the expensive misses here — a too-broad IAM policy, a credential-leaking workflow — are what a weaker reviewer waves through.

Run `architect` as the main session agent (`claude --agent architect`), not as a subagent: Claude Code strips `Agent` and `AskUserQuestion` from subagents, and subagents cannot call each other, so the architect owns every hand-off.

## PR descriptions

Every PR description ends with an **Ops tasks** section listing the manual steps needed after merge — third-party resources (Stripe prices/webhooks, OAuth clients), env vars, GitHub repo variables, SAM parameter overrides, DNS or console configuration, one-time deploy or migration commands. Write "None" explicitly if there are none.
