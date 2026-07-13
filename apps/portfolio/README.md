# Portfolio — austinjuliuskim.com

Personal portfolio + résumé site. Static React (Vite + TypeScript), served from
private S3 + CloudFront. Positions Austin for AI engineering roles (LLM/agent,
AI infra, full-stack AI).

## Structure

- `src/data.ts` — **single source of truth for all copy** (profile, about,
  projects, experience, skills). Edit this to update the site. Items marked
  `[confirm]` need a real figure before going live.
- `src/pages/Home.tsx` — one-page scrolling site (hero, about, work, skills, contact).
- `src/pages/Resume.tsx` + `resume.css` — `/resume` route, styled for screen and
  print. "Download PDF" = browser Print → Save as PDF (one page).
- `deliverables/` — paste-ready career artifacts:
  - `resume.md` — plain-markdown résumé (mirror of the `/resume` page).
  - `linkedin-copy-pack.md` — headline, About, experience bullets, skills, Featured.
- `template.yaml` / `deploy-params.json` / `deploy-frontend.sh` — S3+CloudFront
  deploy, mirroring `apps/guided-repl`.

## Develop

```
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build → dist/
npm run preview  # serve the production build
```

## Deploy

**CI/CD:** pushes to `main` that touch `apps/portfolio/**` build and deploy
automatically via `.github/workflows/portfolio.yml` (OIDC role
`portfolio-github-deploy`, no stored AWS keys). PRs run the build only.

**One-time bootstrap** (admin AWS creds): `scripts/bootstrap-infra.sh` provisions
the ACM cert + DNS validation, the GitHub OIDC deploy role (trust +
`docs/iam-policy.json`), and the initial CloudFormation stack, then upserts the
apex Route53 alias. Idempotent — safe to re-run. `--dry-run` to preview.

**Manual deploy:** `npm run deploy` (runs `deploy-frontend.sh`: build → S3 sync →
CloudFront invalidation), reading stack outputs from `deploy-params.json`.

## Status

Content is filled in and NDA-reviewed. The ACM cert ARN is set in
`deploy-params.json`. Remaining: run `bootstrap-infra.sh` once to create the
deploy role + stack, then CI takes over.
