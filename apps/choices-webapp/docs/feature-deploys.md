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
  parameter), Lambda, S3 site bucket, Cognito pool, **and its own CloudFront
  distribution**, reached at `https://preview.choices.austinjuliuskim.com`.
  Nothing is shared with prod except the ACM certificate (see below).
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
silently drifts from prod. `WebAclArn` in particular must match what's actually
attached to preview's distribution — see the bootstrap section below.

The `deploy-preview` step also injects the Stripe **Test-mode** secret key,
webhook secret, and `AdminSubs` from GitHub secrets/vars via
`--parameter-overrides` — so preview can fully exercise payment flows. Setup
(register the test webhook endpoint, add the 3 secrets/vars, find your preview
Cognito sub): see **[stripe-preview.md](./stripe-preview.md)**.

## Preview's CloudFront distribution

Preview has its own distribution, subscribed to a CloudFront **Free flat-rate
plan** ($0/mo). Two things about it are load-bearing:

- **`WebAclArn` must be pinned.** A plan-subscribed distribution requires a WAF
  protection pack and forbids removing it, so if the template doesn't declare
  the attached ACL, the *next* CloudFormation update of the distribution fails
  with "You can't remove or replace the web ACL for your distribution." This is
  an account-wide failure mode — it has bitten prod and the portfolio stack
  before (see the vault's CloudFront PAYG Migration Plan). Pin it from day one.
- **Prod's web ACL cannot be reused.** Flat-rate plans forbid sharing a web ACL
  (or CloudFront Function, or KeyValueStore) with another distribution. Preview
  needs its own pack.

The Free plan gives a hard $0 ceiling — no overage regardless of traffic, and
blocked/attack traffic doesn't count against the allowance. The failure mode
under abuse is degraded delivery (fewer/more distant edge locations), never a
bill. Allowances: 1M requests / 100GB per month, 5 cache behaviors (this app
uses 3), 5 WAF rules.

### One-time bootstrap

1. Deploy this template to `ChoicesWebApp-preview` with `CustomDomain` +
   `CertificateArn` set and `WebAclArn=""`. Creates the distribution on
   pay-as-you-go with no WAF (15–30 min).
2. Subscribe **that** distribution to a **Free** plan (console, or the
   `pricingplanmanager` API — it is *not* a CloudFormation resource, same as
   prod's Pro plan). This attaches a `CreatedByCloudFront-*` protection pack.
3. Read the attached ACL:
   `aws cloudfront get-distribution-config --id <preview-dist-id>`.
4. Pin that ARN as `WebAclArn` in **both** `samconfig.toml [preview]` and the
   workflow's `params=()` array, then redeploy preview. The template now
   declares what's attached, so later updates don't drift.
5. Point `preview.choices.austinjuliuskim.com` at the new distribution's domain
   (Route53 A-alias; no DNS IaC exists in this repo).
6. Add `https://preview.choices.austinjuliuskim.com/` to the Google OAuth
   client's authorized redirect URIs (console-only).

The ACM cert is shared with prod: one dual-SAN cert covers both
`choices.austinjuliuskim.com` and `preview.choices.austinjuliuskim.com`, and a
cert can be attached to multiple distributions. Nothing else is shared.

### Why preview is not served off prod's distribution

This was tried (PRs #89–#91, 2026-08-05) and reverted. Recording it so nobody
re-attempts it the same way:

Both hostnames were put on prod's distribution, with a **Lambda@Edge
origin-request** function meant to swap origins based on the `Host` header. It
never worked — **at the `origin-request` trigger CloudFront has already replaced
`request.headers.host` with the *origin's* domain name**, so the function's host
check was always false and it no-op'd on 100% of requests. `/api*` and `/j/*`
traffic to the preview hostname silently reached **prod's** backend and wrote to
prod's DynamoDB table.

The viewer Host is unavailable at that trigger for a structural reason per
behavior, and neither is fixable in place:

- **default (S3):** `CachingOptimized` forwards no headers, and AWS documents
  that Host cannot be forwarded to S3-type origins at all.
- **`/api*`, `/j/*`:** the origin request policy is `AllViewerExceptHostHeader`
  — chosen deliberately because Lambda Function URLs *reject* a forwarded viewer
  Host. The constraint that forces that policy is the same one that makes
  host-based routing impossible there.

Two further reasons not to retry it: CloudFront **multi-tenant distributions**
and **continuous-deployment/staging distributions** are both explicitly
unsupported on flat-rate pricing plans, and **Lambda@Edge invocations are billed
pay-as-you-go even under a flat-rate plan** — so the shared-distribution design
punched a hole in the very no-overage guarantee the plan is bought for.

A separate distribution costs nothing extra (there is no fixed monthly charge
for a distribution) and keeps staging changes from ever touching production.

If host-based routing is ever genuinely needed, the viable trigger is
**viewer-request**, where the real Host *is* visible — CloudFront Functions
runtime 2.0 has `cf.updateRequestOrigin()`, which also supports OAC. Do not use
Lambda@Edge at origin-request for this.

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

Two things to know about teardown:

- **Cancel the Free plan first.** A distribution subscribed to a pricing plan
  cannot be deleted while the subscription is active, so `sam delete` will fail
  on the distribution. Free plans cancel immediately (paid plans persist to the
  end of the billing cycle).
- Prod is entirely unaffected — it shares no resources with preview except the
  ACM cert, which is not deleted by this. Remember to remove the
  `preview.choices...` Route53 record, which would otherwise point at a
  deleted distribution.

## Tier-1 hardening parameters

- `WebAclArn`: **prod is subscribed to a CloudFront flat-rate pricing plan
  (Pro tier, $15/mo)**, which requires its protection-pack web ACL
  (`CreatedByCloudFront-8bb2952d`) to stay associated — CloudFront rejects
  any deploy that removes or replaces it. The samconfig `[default]` value
  must therefore always be that pack's ARN. Preview has the same requirement
  against its **own** pack (Free plan) — a web ACL cannot be shared between
  plan-subscribed distributions. See "Preview's CloudFront distribution".
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
  doesn't send the header (fine while `EnforceOriginHeader` is `false`).
  Preview has this set and runs with `EnforceOriginHeader=true`.
- `EnforceOriginHeader`: flip to `true` only after the frontend uses the
  CloudFront `/api` URL (`ApiBaseUrl` output) and the secret is set.

## Notes / future work

- Cost at idle is ~zero: pay-per-request DynamoDB and Lambda, and preview's
  distribution is on a Free flat-rate plan ($0/mo, WAF included). There is no
  fixed monthly charge for a CloudFront distribution.
- Preview CORS is `*` (no fixed domain to pin). Prod stays pinned.
- CI preview deploys shipped (see "CI preview deploys" above) — the old
  workflow_dispatch idea was superseded by the on-PR `deploy-preview` job.
- Preview is **publicly reachable** — no auth gate. The Free plan's hard $0
  ceiling is what makes that acceptable: bot traffic can't produce a bill, only
  degraded delivery. If it ever needs gating, a WAF rule in **Block** mode is
  the right tool — since Oct 2024 AWS charges no CloudFront request or
  data-transfer fees for WAF-blocked requests, which CloudFront Function 401s
  and geo-restriction 403s do *not* get.
