# Adding a Project

Checklist for dropping a new project into the monorepo. See
[`monorepo-conventions.md`](monorepo-conventions.md) for the rules behind these
steps.

## 1. Pick the right directory

- Deployable product (web app, site)? → `apps/`
- Reusable library imported by apps? → `packages/`
- Standalone backend/script, often non-JS? → `services/`

## 2. Create the project

```bash
mkdir -p apps/<my-project>   # kebab-case
cd apps/<my-project>
```

Initialize it for its stack (e.g. `npm init`, `npm create vite@latest`,
`python -m venv .venv`, etc.). The project must be buildable on its own.

## 3. Add the essentials

- `README.md` — what it is, how to install, run, test, and deploy.
- Dependency manifest + lockfile (`package.json` + `package-lock.json`,
  `pyproject.toml`, …).
- A project `.gitignore` for anything not already covered by the root one
  (build output dirs, framework caches, env files with non-standard names).

## 4. Wire up shared code (if needed)

Consume `packages/*` via a `file:` dependency or relative import — see
"Sharing code without tooling" in the conventions doc. Never import from another
app's source.

## 5. Update the repo map

Add a one-line entry for the new project under the relevant section of the root
[`README.md`](../README.md).

## 6. Commit

Use a project-scoped message:

```
<my-project>: initial scaffold
```
