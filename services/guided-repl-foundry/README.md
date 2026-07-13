# guided-repl-foundry

Lesson Foundry: the admin-facing agentic pipeline that watches the AI-education
landscape, proposes lesson topics on a cadence, and drafts publish-ready lesson
YAML as **draft PRs** — publish is always a human merging the PR (never
full-auto).

Spec: `ObsidianVault/30-projects/Claude REPL Lesson Foundry Spec.md` (v1.3 LOCKED).

Runbook (triggers, secrets, review flow, bench, E2B template) is filled in as
the pipeline lands — see the tasks in the worker brief.

## Config

Lives in the repo-root `foundry/` directory:

- `foundry/sources.yaml` — watched source registry
- `foundry/models.yaml` — role → model routing (scout/author/linter/judge)
- `foundry/settings.yaml` — topN, budget cap, overlap threshold, labels, pricing

All three are loaded and Zod-validated by `src/config.js`; every model id
referenced in models.yaml must have a pricing entry in settings.yaml.

## Tests

```
npm ci   # also run npm ci in packages/guided-repl-protocol and packages/guided-repl-lessons first
npm test
```

Keyless: no API keys, network, `claude` CLI, or E2B needed — all boundaries are
injected fakes.
