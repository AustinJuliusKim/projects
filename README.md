# personal/projects

A convention-based monorepo for personal projects — web apps, a personal site,
shared packages, and assorted services. There is **no build tooling** at the
root (no workspaces, Turborepo, nx, etc.); every project is independently
installable and deployable. Organization is by directory convention, documented
below.

## Layout

```
.
├── apps/        # Deployable applications (web apps, personal site)
│   ├── choices-webapp/   # Vite/React frontend + Node.js Lambda backend (AWS SAM)
│   └── claude-repl/      # Vite/React playground that teaches Claude Code (BYOK)
├── packages/    # Shared, reusable libraries
│   └── claude-repl-protocol/  # WS message contract shared by claude-repl + its backend
├── services/    # Standalone, long-lived backends/scripts
│   └── claude-repl-backend/   # WS server running Claude Code in per-session E2B sandboxes
├── agents/      # Claude agent definitions
└── docs/        # Cross-cutting repo documentation
```

## Conventions

- **`apps/`** — anything you run or deploy as a product.
- **`packages/`** — reusable code imported by apps.
- **`services/`** — standalone backends/scripts, typically a non-JS runtime.
- Each project is self-contained: its own README, dependency manifest, lockfile,
  and deploy config. No cross-app imports — share via `packages/`.

See [`docs/monorepo-conventions.md`](docs/monorepo-conventions.md) for the full
conventions and [`docs/adding-a-project.md`](docs/adding-a-project.md) for the
checklist to add a new project.
