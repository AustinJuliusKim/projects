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

See the header comment in `deploy-frontend.sh`. One-time: issue an ACM cert for
`austinjuliuskim.com` in **us-east-1**, deploy `template.yaml`, point DNS at the
CloudFront distribution. Then `npm run deploy` on every change.

## Before it goes live

Content is filled in and NDA-reviewed. Remaining prerequisites are infra only:
issue the ACM cert for `austinjuliuskim.com` (us-east-1), deploy the stack, and
point DNS — see `deploy-frontend.sh`.
