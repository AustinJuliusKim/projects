# Feature deployments (preview stack)

Deploy a feature branch to an isolated **preview stack** without touching the
production `ChoicesWebApp` stack or `choices.austinjuliuskim.com`.

## How isolation works

- CI deploys **prod** only on push to `main` (`.github/workflows/choices-webapp.yml`,
  `deploy` job gate). Same-repo PRs touching the app deploy the **preview
  stack** automatically (`deploy-preview` job) — see "CI preview deploys"
  below. Fork PRs never deploy (GitHub withholds the OIDC token).
- The preview stack is a second, fully independent CloudFormation stack
  (`ChoicesWebApp-preview`, config env `preview` in `samconfig.toml`): its own
  DynamoDB table (`choices-games-preview`, via the `TableName` template
  parameter), Lambda, and S3 site bucket. **It has no CloudFront distribution
  of its own** (`CreateDistribution=false`) — it's reached at
  `https://preview.choices.austinjuliuskim.com`, served by **prod's** shared
  distribution via a Lambda@Edge origin-request router
  (`ops/edge-preview-router.yaml`, us-east-1, admin-deployed) that inspects
  the `Host` header and routes preview's hostname to preview's own S3
  bucket/Lambda Function URL. Every other Host (prod's) passes through
  unaffected. See "Bootstrap: shared-distribution routing" below for the
  one-time setup this depends on, and the top of `ops/edge-preview-router.yaml`
  for the full rollout runbook.
- Preview uses a dedicated VAPID keypair, never shared with prod. Only the
  public key is committed (`samconfig.toml`); the private key lives solely in
  the CloudFormation stack. On a **fresh** preview stack creation, generate a
  pair (`npx web-push generate-vapid-keys`) and pass everything once on the
  CLI (CLI `--parameter-overrides` replaces the config-file set entirely):

  ```sh
  sam deploy --config-env preview --parameter-overrides \
    'TableName="choices-games-preview" CorsAllowOrigin="*" \
     VapidPublicKey="<new public>" VapidPrivateKey="<new private>" \
     VapidSubject="mailto:austinjuliuskim@gmail.com"'
  ```

  (Update the committed public key in `samconfig.toml` to match.) Subsequent
  `sam deploy --config-env preview` updates reuse the stored private key.

## CI preview deploys (automatic, on PR)

The `deploy-preview` job runs on every same-repo PR that touches
`apps/choices-webapp/**`: `sam deploy --config-env preview` + the frontend
script against `ChoicesWebApp-preview`, then comments the preview URL on the
PR (once, on open). The preview stack is **shared** — concurrent PRs
serialize via the workflow concurrency group and the last deploy wins.

One-time IAM setup on `choices-webapp-github-deploy` (both applied via the
admin profile; keep `docs/iam-policy.json` in sync):

1. Trust policy: allow the `pull_request` OIDC sub alongside `main`:
   `"token.actions.githubusercontent.com:sub": ["repo:AustinJuliusKim/projects:ref:refs/heads/main", "repo:AustinJuliusKim/projects:pull_request"]`
   (fork PRs are excluded by GitHub itself: no `id-token` for forks; a
   same-repo `pull_request` run could in principle deploy prod, which is
   acceptable on a repo where only the owner can push branches).
2. Inline policy `choices-webapp-deploy`: broaden the two bucket patterns to
   match preview names — `choiceswebapp-sitebucket-*` → `choiceswebapp*sitebucket-*`
   (and `/*`), `choiceswebapp-suggestdatabucket-*` → `choiceswebapp*suggestdatabucket-*`.
   All other patterns (`ChoicesWebApp*`, `choices-games*`, `choices_events*`)
   already match the preview stack's resource names.

Because the CLI's `--parameter-overrides` **replaces** samconfig's list rather
than merging it, every new `template.yaml` parameter has to be added in *both*
the workflow's `params=()` array and `samconfig.toml [preview]`, or preview
silently drifts from prod. Preview also carries no `WebAclArn` by design (it
has no distribution of its own to protect — see below).

The `deploy-preview` step also injects the Stripe **Test-mode** secret key,
webhook secret, and `AdminSubs` from GitHub secrets/vars via
`--parameter-overrides` — so preview can fully exercise payment flows. Setup
(register the test webhook endpoint, add the 3 secrets/vars, find your preview
Cognito sub): see **[stripe-preview.md](./stripe-preview.md)**.

## Bootstrap: shared-distribution routing

Preview used to have its own CloudFront distribution (recurring headache: the
account's Free-plan protection pack kept attaching to it out-of-band, the same
issue documented in the vault's CloudFront PAYG Migration Plan). It's been
retired in favor of routing `preview.choices.austinjuliuskim.com` through
prod's shared, already-hardened distribution. One-time setup, in order:

1. Deploy this template to `ChoicesWebApp-preview` with
   `CreateDistribution=false`, `CustomDomain=preview.choices.austinjuliuskim.com`,
   and a **real** `OriginVerifySecret` (`openssl rand -hex 32`, passed once via
   `--parameter-overrides`, recorded somewhere durable — NoEcho parameters
   aren't recoverable via `describe-stacks`). This deletes preview's old
   distribution (slow — CloudFront disables then deletes, expect 15–30+ min).
   **Preview is unreachable at any URL until step 4.**
2. Read the resulting stack's `SiteBucketName` and `ApiUrl` outputs; derive
   `PreviewSiteBucketDomain` (`<bucket>.s3.<region>.amazonaws.com`) and
   `PreviewApiOriginDomain` (the `ApiUrl` host only, same parsing
   `deploy-frontend.sh`/this template already do elsewhere).
3. Admin-deploy `ops/edge-preview-router.yaml` (us-east-1) with those two
   values, `PreviewAliasHostname=preview.choices.austinjuliuskim.com`, and the
   same `OriginVerifySecret` from step 1. Capture its
   `PreviewEdgeRouterVersionArn` output.
4. Request a new ACM cert (us-east-1) with SANs
   `[choices.austinjuliuskim.com, preview.choices.austinjuliuskim.com]`;
   complete DNS validation. Deploy this template to **prod**
   (`ChoicesWebApp`) with the new `CertificateArn`,
   `PreviewAliasHostname=preview.choices.austinjuliuskim.com`, and
   `PreviewEdgeFunctionArn` set to the ARN from step 3 — this is the moment
   the preview subdomain goes live.
5. Add the `preview.choices.austinjuliuskim.com` DNS record (same target as
   the existing apex record — no Route53/DNS IaC exists anywhere in this
   repo) and add `https://preview.choices.austinjuliuskim.com/` to the Google
   OAuth client's authorized redirect URIs (console-only).

**Ongoing:** ordinary `deploy-preview` CI runs do *not* repeat any of this —
`SiteBucket`/`ApiFunction`/`ApiFunctionUrl` physical IDs stay stable across
routine updates, so the edge router's baked-in domains stay valid. The one
thing that *does* need re-running is step 3 (re-deploy the router) followed by
step 4's prod redeploy (re-copy the new ARN) whenever
`ops/edge-preview-router.yaml`'s code changes, or in the rare case preview's
bucket or Function URL gets replaced (full teardown/recreate, or a future
template change that happens to force-replace either resource) — the router's
baked-in domains would go stale otherwise. `OriginVerifySecret` gates both the
API origin's `x-origin-verify` header (existing pattern) and the S3 bucket's
`Referer`-based policy (`PreviewSiteBucketPolicy` in `template.yaml`) — see
that resource's comment for why Referer, not OAC/OAI, secures the S3 side
here (both turned out to be dead ends for an origin Lambda@Edge constructs at
request time).

## Deploy (local, from any branch)

Also possible with an admin AWS session (`aws login`) when you want a preview
without opening a PR:

```sh
cd apps/choices-webapp
sam build
sam deploy --config-env preview
STACK_NAME=ChoicesWebApp-preview ./deploy-frontend.sh
```

`deploy-frontend.sh` reads the preview stack's outputs (API URL, bucket,
distribution), builds the frontend against them, syncs, and invalidates.
The app URL is the `SiteUrl` stack output (printed by the script).

## Teardown

```sh
aws s3 rm "s3://$(aws cloudformation describe-stacks --stack-name ChoicesWebApp-preview \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)" --recursive
sam delete --config-env preview
```

This deletes preview's bucket/table/Lambda but doesn't touch prod's
`PreviewAliasHostname`/`PreviewEdgeFunctionArn` — `preview.choices...` would
keep resolving through the edge router to a bucket/Function URL that no
longer exists (502s) until preview is recreated (re-run the bootstrap above)
or those two params are cleared on prod.

## Tier-1 hardening parameters

- `WebAclArn`: **prod is subscribed to a CloudFront flat-rate pricing plan
  (Pro tier, $15/mo)**, which requires its protection-pack web ACL
  (`CreatedByCloudFront-8bb2952d`) to stay associated — CloudFront rejects
  any deploy that removes or replaces it. The samconfig `[default]` value
  must therefore always be that pack's ARN. Preview carries no `WebAclArn`
  of its own (`CreateDistribution=false` means it has no distribution to
  protect) — but since preview traffic now arrives through prod's shared
  distribution, it's covered by this same WAF pack, unlike the old
  standalone-distribution setup where preview had none at all.
- **WAF rules are managed by `ops/edge-waf.yaml` (us-east-1, admin-deployed).**
  Because the plan blocks swapping the association, that stack *imports* the
  console-created pack rather than creating one; the ARN pinned above never
  changes. Baseline contents (all Count until each soak completes): 3 AWS
  managed groups (IP reputation, Common, Known Bad Inputs) +
  `ChoicesRateLimitPerIp` (600 req/5 min/IP, all traffic; live CloudWatch
  metric name is `choices-rate-per-ip`), then the Pro-tier bot rules behind
  `EnableBotRules`. The soak levers are `ManagedRulesMode` (baseline groups)
  and `BotRuleMode` (bot rules) — both default Count.
- **What the Pro tier does and doesn't give you.** Unlocked vs Free: 25 WAF
  rules instead of 5, scope-down statements (so rate limits can target
  `/api*` writes and `/j/*` separately), header matching, the CAPTCHA action,
  custom block responses, CloudFront access logs + WAF logs with free
  CloudWatch Logs ingestion, 10 cache behaviors, and the AI-traffic-analytics
  console dashboard. Still **Business-tier+** ($200/mo) and therefore still
  unavailable: AWS WAF Bot Control, the JavaScript challenge, regex match
  statements, custom cache policies, and custom origin request policies.
  There is no managed bot ruleset at Pro — `ops/edge-waf.yaml`'s bot defense
  is hand-built from rate limits, header heuristics, and CAPTCHA.
- **CAPTCHA precondition (blocks Phase 4).** The frontend has no AWS WAF
  CAPTCHA integration — no `aws-waf-integration` SDK, no challenge handling
  in `lib/api.js`. A WAF CAPTCHA interstitial served to a `fetch()` cannot be
  solved without it, and `CreatePairingCaptcha` matches *every* createPairing
  request — so flipping `BotRuleMode=Enforce` today would break pairing
  creation for all users. Integrate the SDK (or change that rule's enforce
  action) before enforcing.
- **Business upgrade trigger.** Move to Business when either (a) `/j/*`
  scraping survives the rate + CAPTCHA rules for two consecutive weeks in the
  WAF logs, or (b) `getState` polling volume makes a 1s-TTL edge cache worth
  more than the $185/mo delta. Both are the same purchase: (a) buys Bot
  Control and the JS challenge, (b) buys custom cache policies.
- The `/api*` cache behavior uses the AWS managed `CachingDisabled` policy:
  custom cache policies are Business-tier+ under pricing plans, and the
  managed caching-enabled alternatives put `host` in the cache key, which
  Lambda Function URLs reject when forwarded. No edge caching on the API —
  adaptive polling and the rate limit are the load/cost controls.
- The default and `/j/*` behaviors carry the AWS managed
  `SecurityHeadersPolicy` (HSTS, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy). *Managed* response-headers policies work on every tier;
  only custom ones are Business-tier+. `/api*` is deliberately left off it so
  the Lambda's own response headers stay authoritative.
- `OriginVerifySecret`: same handling as the VAPID private key — pass once
  via `--parameter-overrides` on a fresh deploy (e.g. `openssl rand -hex 32`),
  never commit; later deploys reuse the stored value. Blank = CloudFront
  doesn't send the header (fine while `EnforceOriginHeader` is `false`). On a
  `CreateDistribution=false` stack (preview), this same value also gates the
  S3 bucket's `Referer`-based policy (`PreviewSiteBucketPolicy`) — blank
  there means the edge router can't read the bucket at all, not just a
  weaker check.
- `EnforceOriginHeader`: flip to `true` only after the frontend uses the
  CloudFront `/api` URL (`ApiBaseUrl` output) and the secret is set.

## Notes / future work

- Cost at idle is ~zero (pay-per-request DynamoDB, Lambda; no distribution or
  WAF ACL of its own to pay for either, now that it shares prod's).
- Preview CORS is `*` (no fixed domain to pin). Prod stays pinned.
- CI preview deploys shipped (see "CI preview deploys" above) — the old
  workflow_dispatch idea was superseded by the on-PR `deploy-preview` job.
- `deploy-frontend.sh`'s `aws cloudfront create-invalidation --paths "/*"`
  now invalidates the **shared** prod distribution when run against the
  preview stack (its `DistributionId` output resolves to
  `SharedDistributionId`) — harmless and cheap, but if it's ever worth
  narrowing, scope it to `/__preview/*`, `/api*`, `/j/*` instead of `/*`.
