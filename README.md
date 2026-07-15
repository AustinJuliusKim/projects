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
│   └── guided-repl/      # Vite/React SPA: fixture-replayed walkthrough of using Claude Code
├── packages/    # Shared, reusable libraries
│   └── guided-repl-protocol/  # Frame vocabulary + fixture schema shared by guided-repl + its seeder
├── services/    # Standalone, long-lived backends/scripts
│   └── guided-repl-seeder/    # Node CLI that records real Claude Code runs into fixtures
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

## ObsidianVault submodule

The personal knowledge base ([`AustinJuliusKim/ObsidianVault`](https://github.com/AustinJuliusKim/ObsidianVault))
is linked at `ObsidianVault/` as a git submodule. It holds project plans,
decisions, and roadmaps that inform work in this repo.

```bash
# Clone the repo with the vault already populated
git clone --recurse-submodules git@github.com:AustinJuliusKim/projects.git

# Already cloned? Initialize / fetch the submodule
git submodule update --init ObsidianVault

# Update the pin to the latest vault main (then commit the moved gitlink)
git submodule update --remote ObsidianVault
git add ObsidianVault && git commit -m "Bump ObsidianVault submodule"
```
