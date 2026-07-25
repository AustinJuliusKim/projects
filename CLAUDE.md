# CLAUDE.md

## ObsidianVault: check for related notes first

Before starting work on any task in this repo, scan the ObsidianVault for notes related to the topic — especially `30-projects/` (per-project plans and decisions) and `10-maps/Projects MOC.md` (index). Use grep/find to locate relevant notes by keyword rather than reading the whole vault.

Resolve the vault location in this order:
1. **Absolute local path** `/Users/aukim/personal/ObsidianVault/` — the source of truth, always the most current. Use it whenever it resolves.
2. **In-repo submodule** `./ObsidianVault/` — fallback when the absolute path is unavailable (e.g. running in CI or a remote/cloud session). Note this is pinned to a commit and may be out of date; run `git submodule update --init ObsidianVault` first, and treat its notes as potentially stale relative to the absolute path.

These notes contain locked decisions, roadmaps, and context that override assumptions derived from code alone (e.g. `30-projects/Choices Growth Plan.md` for the choices-webapp). When a task conflicts with or changes a documented plan, mention it.

After completing work that changes files under `apps/`, `packages/`, or `services/`, run `/vault-sync` before shipping or opening a PR, so the vault's `30-projects/` notes stay accurate to the code.

## Agents and model routing

Two sets of agent definitions exist, for two different tools:

- **`.claude/agents/`** — Claude Code format. These are the ones Claude Code loads.
- **`agents/`** — the original OpenCode definitions (`mode:`, `temperature:`, `tools:` as a boolean map, provider-prefixed model IDs). Kept as-is; Claude Code does not read them.

The Claude Code set is a port of the OpenCode one, so keep them in step when either changes.

| Agent | Model | Role |
|---|---|---|
| `architect` | `fable` | Plans work, writes Task Briefs under `misc/coding-team/`, drives the loop. Never implements. |
| `developer` | `sonnet` | Implements exactly one Task Brief. |
| `code-reviewer` | `opus` | Reviews the diff. Read-only; returns change requests or approval. |
| `repo-scout` | `sonnet` | Orientation in an unfamiliar area; reports drift between the code, `CLAUDE.md`, and the vault. |

Routing is cheapest-model-that-does-the-job with no auto-escalation. `code-reviewer` is on Opus because the expensive misses here — a too-broad IAM policy, a credential-leaking workflow, a low-ROI test suite that ossifies — are exactly what a weaker reviewer waves through. `repo-scout` is on Sonnet rather than Haiku because orienting in a multi-app monorepo is not a simple lookup. (In `christine-portfolio`, which is one small static site, the same agent is on Haiku.)

**Run `architect` as the main session agent** — `claude --agent architect` — not as a subagent. Claude Code strips `Agent` and `AskUserQuestion` from subagents, so an architect spawned as one could neither ask questions nor delegate. As the main session agent it has both, and it owns every hand-off because **subagents cannot call each other**.

The OpenCode originals reference `@code-reviewerer`, `@code-reviwerer` and `@diff-summarizer`, none of which exist as files. Those references are dropped in the Claude Code port rather than carried over.

## PR descriptions: always document post-completion ops tasks

Every GitHub PR description must end with an **"Ops tasks"** section listing the manual/DevOps steps required after the work is merged — e.g. creating third-party resources (Stripe prices/webhooks, OAuth clients), setting env vars / GitHub repo variables / SAM parameter overrides, DNS or console configuration, and one-time deploy or migration commands. Write "None" explicitly if there are none. This applies to new PRs and to updates of existing PR descriptions when a session adds such requirements.
