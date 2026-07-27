# CLAUDE.md

## Repo shape

A monorepo of independently deployed pieces: `apps/` (choices-webapp, guided-repl, portfolio), `packages/` (shared libraries), `services/` (Lambda/API backends), `ops/` (CloudFormation for alarms, dashboards, canaries), `foundry/`.

There is no workspace root. Each area owns its own `package.json`, deploy workflow, and AWS stack — `cd` into the area you're working in and run its scripts there. CI runs `npm ci && npm test && npm run build` per area.

- Tests use Node's built-in runner (`node --test`). Don't introduce a second framework.
- `npm run check` exists in some areas (e.g. `packages/guided-repl-lessons`).
- `apps/portfolio` is build-only and has no test script by design — its absence is not a gap.
- Don't run deploy scripts or `bootstrap-infra.sh`.

## ObsidianVault

The vault holds locked decisions and roadmaps that override assumptions drawn from code alone — `30-projects/Choices Growth Plan.md` governs choices-webapp, for example. Scan it for related notes when a task touches documented project decisions, using grep by keyword rather than reading it whole. Index is `10-maps/Projects MOC.md`. If the work would change something a note documents, say so rather than quietly diverging.

Resolve the vault location in this order:

1. `/Users/aukim/personal/ObsidianVault/` — the source of truth, always current.
2. `./ObsidianVault/` — in-repo submodule, for CI or remote sessions where the absolute path doesn't resolve. Pinned to a commit and possibly stale; run `git submodule update --init ObsidianVault` first.

Run `/vault-sync` before shipping work that changed `apps/`, `packages/`, or `services/`.

## Agents

`.claude/agents/` holds `architect` (fable), `developer` (sonnet), `code-reviewer` (opus), `repo-scout` (sonnet). Routing is the cheapest model that does the job. `code-reviewer` is on Opus because the expensive misses here — a too-broad IAM policy, a credential-leaking workflow — are what a weaker reviewer waves through.

Run `architect` as the main session agent (`claude --agent architect`), not as a subagent: Claude Code strips `Agent` and `AskUserQuestion` from subagents, and subagents cannot call each other, so the architect owns every hand-off.

## PR descriptions

Every PR description ends with an **Ops tasks** section listing the manual steps needed after merge — third-party resources (Stripe prices/webhooks, OAuth clients), env vars, GitHub repo variables, SAM parameter overrides, DNS or console configuration, one-time deploy or migration commands. Write "None" explicitly if there are none.
