# Monorepo Conventions

This repo is a **convention-based** monorepo. There is no root package manager,
workspace config, or task runner. Each project stands on its own; the value here
is one place to find everything, shared docs/conventions, and atomic commits
across projects. This document defines the rules that keep that workable.

## Directory roles

| Directory   | Holds                                              | Examples                          |
|-------------|---------------------------------------------------|-----------------------------------|
| `apps/`     | Things you run or deploy as a product             | `choices-webapp`, `personal-site` |
| `packages/` | Reusable libraries imported by apps               | `ui`, `utils`, `api-client`       |
| `services/` | Standalone backends/scripts, often non-JS         | a Python API, a cron script       |
| `agents/`   | Claude agent definitions                          | —                                 |
| `docs/`     | Cross-cutting repo documentation                  | this file                         |

`packages/` and `services/` are created when first needed — don't scaffold them
empty.

## Rules

1. **Self-contained projects.** Every project owns its README, dependency
   manifest (`package.json`, `pyproject.toml`, …), lockfile, and deploy config.
   You can `cd` into any project and build/test/deploy it without the root.
2. **kebab-case directory names** (`choices-webapp`, not `choicesWebApp`).
3. **No cross-app imports.** An app must not reach into another app's source.
   Shared code goes in `packages/` (JS) or `services/` (standalone runtimes).
4. **Project-scoped commit messages.** Prefix with the project name, e.g.
   `choices-webapp: fix push routing`. Repo-wide changes use a `repo:` or
   `docs:` prefix.
5. **Ignores.** Generic, language-agnostic ignores live in the root
   `.gitignore`. Project-specific ignores live in the project's own `.gitignore`.

## Sharing code without tooling

Because there's no workspace linker, shared `packages/*` are consumed explicitly:

- **JS — preferred:** add a file dependency in the consuming app's
  `package.json`:
  ```json
  { "dependencies": { "@me/utils": "file:../../packages/utils" } }
  ```
  Run `npm install` in the app to symlink it. Re-run after changing the
  package's `package.json`.
- **JS — quick/relative:** import via a relative path
  (`import { x } from '../../packages/utils/index.js'`). Fine for small,
  rarely-changed helpers; the file dependency is cleaner once shared widely.
- **Non-JS:** follow that ecosystem's local-path mechanism (e.g. Python
  `pip install -e ../../packages/foo`, or path entries in `pyproject.toml`).

## Per-language notes

- **JavaScript/Node:** npm per project; each keeps its own `package-lock.json`
  and `node_modules/`.
- **Python:** each project gets its own virtualenv (`.venv/`) and
  `pyproject.toml`/`requirements.txt`. Don't share a venv across projects.

## Upgrade path (if/when JS sharing grows)

If shared JS packages become common and the manual `file:` installs get tedious,
adopt **npm workspaces** non-destructively: add a root `package.json`:

```json
{ "private": true, "workspaces": ["apps/*", "packages/*"] }
```

Then a single root `npm install` links everything. This only affects JS projects
matched by the globs — `services/` and non-JS code are untouched. No other
tooling (Turborepo/nx) is implied; add that only if task caching becomes a real
need.
