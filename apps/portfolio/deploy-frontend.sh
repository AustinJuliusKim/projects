#!/usr/bin/env bash
# Build the portfolio and publish it to S3 + CloudFront.
# Reads bucket name, distribution id, and site URL from the CloudFormation
# stack outputs. Params (stack name, region) come from deploy-params.json
# unless overridden via STACK_NAME/REGION env vars.
#
# First-time setup (once, admin creds): run scripts/bootstrap-infra.sh — it
# provisions the ACM cert/DNS, the GitHub OIDC deploy role, and the initial
# stack. After that, pushes to main deploy automatically via
# .github/workflows/portfolio.yml. Run this script directly for a manual deploy.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PARAMS_FILE="deploy-params.json"

read_param() {
  python3 -c "import json; print(json.load(open('$PARAMS_FILE')).get('$1', ''))"
}

STACK_NAME="${STACK_NAME:-$(read_param StackName)}"
REGION="${REGION:-$(read_param Region)}"
STACK_NAME="${STACK_NAME:-Portfolio}"
REGION="${REGION:-us-west-2}"

echo "Reading stack outputs from '$STACK_NAME' ($REGION)…"
get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

BUCKET="$(get_output SiteBucketName)"
DIST_ID="$(get_output DistributionId)"
SITE_URL="$(get_output SiteUrl)"

if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "ERROR: SiteBucketName output not found. Did you deploy template.yaml?" >&2
  exit 1
fi

echo "Building…"
npm ci
npm run build

echo "Uploading to s3://$BUCKET (long-cache, immutable)…"
aws s3 sync dist/ "s3://$BUCKET" --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude index.html

echo "Uploading index.html (no-cache)…"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache"

echo "Invalidating CloudFront cache for /index.html ($DIST_ID)…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" >/dev/null

echo ""
echo "Deployed. Your portfolio:"
echo "   $SITE_URL"
