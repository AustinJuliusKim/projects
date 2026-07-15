# CLAUDE.md

## ObsidianVault: check for related notes first

Before starting work on any task in this repo, scan the ObsidianVault for notes related to the topic — especially `30-projects/` (per-project plans and decisions) and `10-maps/Projects MOC.md` (index). Use grep/find to locate relevant notes by keyword rather than reading the whole vault.

Resolve the vault location in this order:
1. **Absolute local path** `/Users/aukim/personal/ObsidianVault/` — the source of truth, always the most current. Use it whenever it resolves.
2. **In-repo submodule** `./ObsidianVault/` — fallback when the absolute path is unavailable (e.g. running in CI or a remote/cloud session). Note this is pinned to a commit and may be out of date; run `git submodule update --init ObsidianVault` first, and treat its notes as potentially stale relative to the absolute path.

These notes contain locked decisions, roadmaps, and context that override assumptions derived from code alone (e.g. `30-projects/Choices Growth Plan.md` for the choices-webapp). When a task conflicts with or changes a documented plan, mention it.

After completing work that changes files under `apps/`, `packages/`, or `services/`, run `/vault-sync` before shipping or opening a PR, so the vault's `30-projects/` notes stay accurate to the code.

## PR descriptions: always document post-completion ops tasks

Every GitHub PR description must end with an **"Ops tasks"** section listing the manual/DevOps steps required after the work is merged — e.g. creating third-party resources (Stripe prices/webhooks, OAuth clients), setting env vars / GitHub repo variables / SAM parameter overrides, DNS or console configuration, and one-time deploy or migration commands. Write "None" explicitly if there are none. This applies to new PRs and to updates of existing PR descriptions when a session adds such requirements.
