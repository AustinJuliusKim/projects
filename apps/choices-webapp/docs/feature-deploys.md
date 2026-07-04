# Feature deployments (preview stack)

Deploy a feature branch to an isolated **preview stack** without touching the
production `ChoicesWebApp` stack or `choices.austinjuliuskim.com`.

## How isolation works

- CI only deploys on push to `main` (`.github/workflows/choices-webapp.yml`,
  `deploy` job gate), so feature branches and PRs never deploy anything.
- The preview stack is a second, fully independent CloudFormation stack
  (`ChoicesWebApp-preview`, config env `preview` in `samconfig.toml`): its own
  DynamoDB table (`choices-games-preview`, via the `TableName` template
  parameter), Lambda, S3 site bucket, and CloudFront distribution. No custom
  domain — use the CloudFront URL from stack outputs.
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

## Deploy (local, from any branch)

Requires an admin AWS session (`aws login`) — the CI OIDC role is scoped to the
prod stack names and cannot deploy the preview stack.

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

## Tier-1 hardening parameters

- `WebAclArn`: **prod is subscribed to a CloudFront flat-rate pricing plan
  (Free tier)**, which requires its protection-pack web ACL
  (`CreatedByCloudFront-8bb2952d`) to stay associated — CloudFront rejects
  any deploy that removes or replaces it. The samconfig `[default]` value
  must therefore always be that pack's ARN. Preview is not on a plan and
  runs without WAF (`WebAclArn=""`).
- **WAF rules live in the protection pack, managed via the WAF console/API
  (us-east-1), not in git** — the pricing plan blocks CloudFormation from
  swapping the ACL. Current contents (all Count mode until soak completes):
  3 AWS managed groups (IP reputation, Common, Known Bad Inputs) +
  `ChoicesRateLimitPerIp` (600 req/5 min/IP, all traffic). Free-plan limits:
  5 rules max, plain IP rate rules only (no scope-down/URI/body matching),
  so there is no createPairing-specific rule — the generic cap plus billing
  alarms are the backstop. Revisit if the app outgrows the plan.
- The `/api*` cache behavior uses the AWS managed `CachingDisabled` policy:
  custom cache policies are Business-tier+ under pricing plans, and the
  managed caching-enabled alternatives put `host` in the cache key, which
  Lambda Function URLs reject when forwarded. No edge caching on the API —
  adaptive polling and the rate limit are the load/cost controls.
- `OriginVerifySecret`: same handling as the VAPID private key — pass once
  via `--parameter-overrides` on a fresh deploy (e.g. `openssl rand -hex 32`),
  never commit; later deploys reuse the stored value. Blank = CloudFront
  doesn't send the header (fine while `EnforceOriginHeader` is `false`).
- `EnforceOriginHeader`: flip to `true` only after the frontend uses the
  CloudFront `/api` URL (`ApiBaseUrl` output) and the secret is set.

## Notes / future work

- Cost at idle is ~zero (pay-per-request DynamoDB, Lambda, CloudFront).
- Preview CORS is `*` (no fixed domain to pin). Prod stays pinned.
- To deploy previews from CI later: add a `workflow_dispatch` job and broaden
  the OIDC role policy (`docs/iam-policy.json`) from `ChoicesWebApp`/
  `choices-games` to `ChoicesWebApp*`/`choices-games*`.
