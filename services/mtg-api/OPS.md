# MTG project — consolidated ops runbook

Every manual step needed to take the MTG card database from merged code to
live service, consolidated from PRs #74 (plan + phase 1), #75 (phase 2),
#76 (phase 3), #77 (phase 4 webapp), and this PR (phase 5 — third-party API
keys + rate limiting). Steps are ordered — each block depends on the ones
before it. Check items off here as they're done; this file is the living
checklist (the per-PR "Ops tasks" sections are the historical record).

All AWS work is in account `549883968767`, region `us-west-2`, with admin
credentials (the CI roles deliberately can't do any of this).

## 1. Database (phase 1 — enables the ingest cron)

- [x] Create the Supabase project, **Free tier**.
- [x] In the SQL editor, create the ingest role and let it own the schema:

  ```sql
  CREATE ROLE mtg_ingest LOGIN PASSWORD '<generate>';
  GRANT ALL ON SCHEMA public TO mtg_ingest;
  ```

- [x] Run the first migrations **as `mtg_ingest`** so it owns the tables
  (in practice the first run went in under the wrong role — see the
  ownership fix in section 2's notes)
  (later `ALTER`s in the deploy job then need no superuser):

  ```bash
  cd services/mtg-api
  DATABASE_URL='postgresql://mtg_ingest:...@<project>.pooler.supabase.com:5432/postgres' \
    make migrate
  ```

- [x] Set the GitHub repo **secret** `MTG_DATABASE_URL` = that session-pooler
  URI (port **5432**). Done 2026-08-04T05:39:36Z (audit-verified via
  `gh api repos/.../actions/secrets/MTG_DATABASE_URL`); later rotated after
  the `mtg_ingest` password reset (section 2 notes).
- [x] Actions → "mtg ingest" → Run workflow (defaults). First
  `workflow_dispatch` run completed successfully 2026-08-04T05:45:23Z
  ([run 30881411085](https://github.com/AustinJuliusKim/projects/actions/runs/30881411085),
  audit-verified via `gh run view`).
- [ ] Spot-check in the Supabase SQL editor: `SELECT count(*) FROM cards;`
  ≈ 35k, `SELECT pg_size_pretty(pg_database_size(current_database()));`
  (~200MB) — the workflow run succeeded but row counts/size haven't been
  eyeballed in the dashboard yet.
- The cron (Mon+Thu 09:17 UTC) now runs on its own and keeps the Free-tier
  project from pausing. Failure emails from GitHub are the alarm.

## 2. API deploy (phase 2 — puts the FastAPI service live)

- [x] Create IAM role `mtg-api-github-deploy`: policy from
  `services/mtg-api/docs/iam-policy.json` (already includes the Bedrock
  statement for step 3), trust policy = the repo's GitHub OIDC pattern used
  by the other `*-github-deploy` roles.
- [x] First stack creation, manual, with full overrides:

  ```bash
  cd services/mtg-api
  make deploy-bootstrap DatabaseUrl='postgresql://mtg_ingest:...@<project>.pooler.supabase.com:6543/postgres'
  ```

  Note the **transaction pooler, port 6543** here (Lambda), vs 5432 for
  ingest/migrations.

  Local build needed `sam build --use-container` (no Python 3.12 on PATH) —
  with Docker Desktop, also needs
  `DOCKER_HOST=unix:///Users/aukim/.docker/run/docker.sock` since the SAM CLI
  looks for the default `/var/run/docker.sock` context, not
  `desktop-linux`.

  Hit two credential issues fixed along the way, worth knowing for next
  time: (1) Supabase's pooler username is `<role>.<project-ref>` —
  `mtg_ingest.<ref>`, not `mtg_ingest` — easy to conflate with the default
  `postgres.<ref>` connection string from the dashboard's Connect dialog.
  (2) The `mtg_ingest` password from step 1 wasn't retrievable (Postgres
  never stores plaintext), so it was reset via `ALTER ROLE mtg_ingest WITH
  PASSWORD '...'` and the `MTG_DATABASE_URL` secret updated to match. That
  surfaced a deeper issue: `cards` and friends were owned by `postgres`, not
  `mtg_ingest` (the phase-1 migration likely ran under the wrong
  connection string too), causing `permission denied for table cards` from
  the Lambda. Fixed with `GRANT mtg_ingest TO postgres;` (Supabase's
  `postgres` role needs membership before it can hand off ownership) then
  `ALTER TABLE ... OWNER TO mtg_ingest` / `ALTER SEQUENCE ... OWNER TO
  mtg_ingest` looped over everything in `public`.
- [x] Smoke: `curl https://<ApiEndpoint output>/v1/healthz` and open
  `/docs`. Endpoint: `voxxyxdyu9.execute-api.us-west-2.amazonaws.com`.
  `/v1/healthz` → `{"ok":true}`, `/docs` → 200, `/v1/cards/random` returns a
  real card.
- [x] Set repo **variable** `MTG_DEPLOY_ENABLED=true` — the CI deploy job on
  main is armed from now on.

## 3. Similarity (phase 3 — first real embedding run)

- [ ] Confirm the deploy role carries the `BedrockEmbed` statement (it does
  if the role was created from the current `iam-policy.json`; if the role
  predates phase 3, re-apply the policy). Ensure Bedrock model access for
  Titan Text Embeddings V2 is enabled in the us-west-2 console.
- [x] Set repo **variable** `MTG_EMBED_ENABLED=true`. Done 2026-08-04T17:55Z
  (verified via `gh variable list`).
- [ ] Actions → "mtg ingest" → Run workflow. First embed covers all ~35k
  cards: ~1h runtime, **≈$0.50 one-time**. (Later runs only re-embed
  changed cards — pennies.)
- [ ] Fit the confidence calibration against the real embeddings and check
  the quality gate:

  ```bash
  DATABASE_URL='<session pooler :5432>' make eval-calibration
  # paste printed CALIBRATION into src/mtg_api/similar/scoring.py
  DATABASE_URL='<session pooler :5432>' make eval-similar
  # gate: recall@10 >= 0.5 before showing /similar in the webapp
  ```

- [ ] Commit the refreshed constants (ordinary PR).

## 4. Webapp (phase 4 — search/deck-builder frontend)

- [ ] If a custom domain is wanted: ACM cert in **us-east-1** for the domain
  + Route53 record (same pattern as `apps/guided-repl/scripts/bootstrap-infra.sh`).
  Optional — the stack also works on the default CloudFront domain with both
  `CustomDomain` and `CertificateArn` left empty.
- [ ] Fill `apps/mtg-webapp/deploy-params.json`: `ApiOriginDomain` = the
  MtgApi stack's `ApiEndpoint` output (from step 2), plus domain/cert if
  used.
- [ ] Extend the `mtg-api-github-deploy` role with the webapp stack
  permissions (CloudFormation on `MtgWebapp*`, S3 on the site bucket,
  CloudFront invalidation) — or create `mtg-webapp-github-deploy`
  mirroring `apps/guided-repl`'s role; the webapp deploy job assumes
  `mtg-api-github-deploy` by default.
- [ ] First stack creation manual:

  ```bash
  cd apps/mtg-webapp
  aws cloudformation deploy --template-file template.yaml \
    --stack-name MtgWebapp --region us-west-2 \
    --parameter-overrides "ApiOriginDomain=<execute-api domain>" \
    --no-fail-on-empty-changeset
  ./deploy-frontend.sh
  ```

- [ ] Set repo **variable** `MTG_WEBAPP_DEPLOY_ENABLED=true`.

## 5. Third-party API keys (phase 5)

Rate limiting ships **enabled by default** — no template or deploy change
needed; it's live the moment this PR's Lambda deploys.

`RATELIMIT_ENABLED` is a kill-switch, but it's read from the Lambda
environment, and `template.yaml` deliberately doesn't set it — meaning
there's no durable way to disable it from the console today. Flipping it
off there (Lambda console → Configuration → Environment variables) works
until the **next** `sam deploy`, which redeploys from `template.yaml` and
silently wipes the console-only override back to "on". A durable
kill-switch needs a real template parameter — a follow-up if this is ever
actually needed in a hurry.

- [ ] Mint the first real key once a third party actually needs one:

  ```bash
  cd services/mtg-api
  DATABASE_URL='<session pooler :5432>' \
    python scripts/issue_key.py --tier free --label <who>
  ```

  The plaintext key prints once — hand it to the requester immediately,
  it's never recoverable from the database afterward
  (`scripts/issue_key.py`, `docs/third-party-api.md`).
- [ ] **Anonymous edge ceiling — not yet possible without a new ACL.**
  The only existing WAF web ACL in this account
  (`CreatedByCloudFront-8bb2952d`, `ops/edge-waf.yaml`) is
  choices-webapp's CloudFront pricing-plan protection pack: it's
  import-locked to that distribution (the plan forbids swapping a
  subscribed distribution's ACL) and must not be pointed at anything
  else. So today, the Postgres per-key/per-IP limiter
  (`src/mtg_api/ratelimit.py`) is the *only* anonymous ceiling for this
  API — there is no edge-level backstop. A real edge ceiling means
  provisioning a **new**, dedicated CLOUDFRONT-scope WAF ACL for
  `MtgWebapp` (~$6/mo) — a paid-inflection-point decision left to the
  user, not something to do by default. The `WebAclArn` parameter on
  `apps/mtg-webapp/template.yaml` (line 23, wired to `WebACLId`) already
  exists to receive that ACL's ARN whenever that decision is made; leave
  it blank until then.

## 6. Vault note (any time, from a machine with vault access)

- [x] Transpose `services/mtg-api/docs/vault-note-draft.md` →
  `ObsidianVault/30-projects/MTG Card Database.md`, add a line to
  `10-maps/Projects MOC.md`, then **delete the draft file** from this repo.
  Vault note has existed since 2026-08-03; the draft file is deleted in
  this PR.

## Watch after go-live

- Supabase dashboard database size: the Free tier is 500MB; at ~200MB
  (cards+printings+rulings) + ~90–115MB (embeddings) there is headroom, but
  the upgrade trigger is documented in `docs/PLAN.md` ("paid inflection
  points"). Upgrading to Pro ($25/mo) also means raising the $35/mo budget
  alarm in `ops/billing-alarms.yaml`.
- GitHub Actions failure emails from the "mtg ingest" cron — two consecutive
  failures can let the Free-tier project pause; unpausing is one dashboard
  click, data preserved.
- The rate limiter opens a second Postgres connection per request (on top
  of the route's own) — accepted for now; revisit (batch the two, or move
  the counter off Postgres) if p50 latency climbs or the pooler shows
  connection pressure once there's real traffic to measure it against.
