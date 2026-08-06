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
│   ├── guided-repl/      # Vite/React SPA: fixture-replayed walkthrough of using Claude Code
│   ├── baby-solids/      # Vite/React SPA: cited food canon + solids tracker (no server, no DB)
│   └── mtg-webapp/       # Vite/React SPA: MTG card search + deck builder over services/mtg-api
├── packages/    # Shared, reusable libraries
│   ├── baby-core/             # Baby profile + timeline event schemas and merge, shared across baby apps
│   └── guided-repl-protocol/  # Frame vocabulary + fixture schema shared by guided-repl + its seeder
├── services/    # Standalone, long-lived backends/scripts
│   ├── guided-repl-seeder/    # Node CLI that records real Claude Code runs into fixtures
│   └── mtg-api/               # MTG card database: Scryfall ingest + Postgres (FastAPI service to come)
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

> **The vault is a private repository.** The commands below only work if you have
> access to it. For anyone else, `--recurse-submodules` and `submodule update` will
> fail on authentication — that's expected, and nothing else in this repo depends on
> the submodule. No build or CI workflow references it. Clone without
> `--recurse-submodules` and everything works.

```bash
# Clone the repo with the vault already populated
git clone --recurse-submodules git@github.com:AustinJuliusKim/projects.git

# Already cloned? Initialize / fetch the submodule
git submodule update --init ObsidianVault

# Update the pin to the latest vault main (then commit the moved gitlink)
git submodule update --remote ObsidianVault
git add ObsidianVault && git commit -m "Bump ObsidianVault submodule"
```

## License

This repository is **not uniformly licensed**. The root [LICENSE](LICENSE) is
All Rights Reserved and acts as the default; individual projects opt into
something more permissive. Anything not listed below is reserved.

| Project | License |
|---|---|
| `packages/baby-core` | MIT |
| `apps/guided-repl` | MIT |
| `packages/guided-repl-lessons` | MIT |
| `packages/guided-repl-protocol` | MIT |
| `services/guided-repl-api` | MIT |
| `services/guided-repl-foundry` | MIT |
| `services/guided-repl-seeder` | MIT |
| `apps/portfolio` | MIT for code, All Rights Reserved for written content |
| `apps/choices-webapp` | All Rights Reserved |
| `services/mtg-api` | All Rights Reserved |
| `apps/mtg-webapp` | All Rights Reserved |
| `apps/baby-solids` | All Rights Reserved |
| `ops/`, `foundry/`, `.claude/`, `docs/` | All Rights Reserved (root LICENSE) |

Two things worth stating plainly:

- **Public does not mean open source.** The default with no license is that nobody
  may copy or reuse anything. The MIT grants above are the exceptions.
- **`apps/choices-webapp` is reserved on purpose.** It has a commercial roadmap, so
  it is readable but not licensed for use — including running it as a hosted service.

The `ObsidianVault` submodule is a separate private repository and carries none of
these licenses.
