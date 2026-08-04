# MTG project — consolidated ops runbook

Every manual step needed to take the MTG card database from merged code to
live service, consolidated from PRs #74 (plan + phase 1), #75 (phase 2),
#76 (phase 3), and the phase 4 webapp PR. Steps are ordered — each block
depends on the ones before it. Check items off here as they're done; this
file is the living checklist (the per-PR "Ops tasks" sections are the
historical record).

All AWS work is in account `549883968767`, region `us-west-2`, with admin
credentials (the CI roles deliberately can't do any of this).

## 1. Database (phase 1 — enables the ingest cron)

- [ ] Create the Supabase project, **Free tier**.
- [ ] In the SQL editor, create the ingest role and let it own the schema:

  ```sql
  CREATE ROLE mtg_ingest LOGIN PASSWORD '<generate>';
  GRANT ALL ON SCHEMA public TO mtg_ingest;
  ```

- [ ] Run the first migrations **as `mtg_ingest`** so it owns the tables
  (later `ALTER`s in the deploy job then need no superuser):

  ```bash
  cd services/mtg-api
  DATABASE_URL='postgresql://mtg_ingest:...@<project>.pooler.supabase.com:5432/postgres' \
    python scripts/migrate.py
  ```

- [ ] Set the GitHub repo **secret** `MTG_DATABASE_URL` = that session-pooler
  URI (port **5432**).
- [ ] Actions → "mtg ingest" → Run workflow (defaults). Then verify in the
  SQL editor: `SELECT count(*) FROM cards;` ≈ 35k,
  `SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 3;`,
  `SELECT pg_size_pretty(pg_database_size(current_database()));` (~200MB).
- The cron (Mon+Thu 09:17 UTC) now runs on its own and keeps the Free-tier
  project from pausing. Failure emails from GitHub are the alarm.

## 2. API deploy (phase 2 — puts the FastAPI service live)

- [ ] Create IAM role `mtg-api-github-deploy`: policy from
  `services/mtg-api/docs/iam-policy.json` (already includes the Bedrock
  statement for step 3), trust policy = the repo's GitHub OIDC pattern used
  by the other `*-github-deploy` roles.
- [ ] First stack creation, manual, with full overrides:

  ```bash
  cd services/mtg-api
  sam build && sam deploy \
    --stack-name MtgApi --region us-west-2 --resolve-s3 \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides 'DatabaseUrl=postgresql://mtg_ingest:...@<project>.pooler.supabase.com:6543/postgres'
  ```

  Note the **transaction pooler, port 6543** here (Lambda), vs 5432 for
  ingest/migrations.
- [ ] Smoke: `curl https://<ApiEndpoint output>/v1/healthz` and open
  `/docs`.
- [ ] Set repo **variable** `MTG_DEPLOY_ENABLED=true` — the CI deploy job on
  main is armed from now on.

## 3. Similarity (phase 3 — first real embedding run)

- [ ] Confirm the deploy role carries the `BedrockEmbed` statement (it does
  if the role was created from the current `iam-policy.json`; if the role
  predates phase 3, re-apply the policy). Ensure Bedrock model access for
  Titan Text Embeddings V2 is enabled in the us-west-2 console.
- [ ] Set repo **variable** `MTG_EMBED_ENABLED=true`.
- [ ] Actions → "mtg ingest" → Run workflow. First embed covers all ~35k
  cards: ~1h runtime, **≈$0.50 one-time**. (Later runs only re-embed
  changed cards — pennies.)
- [ ] Fit the confidence calibration against the real embeddings and check
  the quality gate:

  ```bash
  DATABASE_URL='<session pooler :5432>' python scripts/eval_similar.py --fit-calibration
  # paste printed CALIBRATION into src/mtg_api/similar/scoring.py
  DATABASE_URL='<session pooler :5432>' python scripts/eval_similar.py
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

## 5. Vault note (any time, from a machine with vault access)

- [ ] Transpose `services/mtg-api/docs/vault-note-draft.md` →
  `ObsidianVault/30-projects/MTG Card Database.md`, add a line to
  `10-maps/Projects MOC.md`, then **delete the draft file** from this repo.

## Watch after go-live

- Supabase dashboard database size: the Free tier is 500MB; at ~200MB
  (cards+printings+rulings) + ~90–115MB (embeddings) there is headroom, but
  the upgrade trigger is documented in `docs/PLAN.md` ("paid inflection
  points"). Upgrading to Pro ($25/mo) also means raising the $35/mo budget
  alarm in `ops/billing-alarms.yaml`.
- GitHub Actions failure emails from the "mtg ingest" cron — two consecutive
  failures can let the Free-tier project pause; unpausing is one dashboard
  click, data preserved.
