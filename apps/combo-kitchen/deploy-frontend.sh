#!/usr/bin/env bash
# Build Combo Kitchen and publish it to S3 + CloudFront.
# Reads bucket name, distribution id, and site URL from the CloudFormation
# stack outputs. Params (stack name, region) come from deploy-params.json
# unless overridden via STACK_NAME/REGION env vars.
#
# First-time setup (once, admin creds): create the GitHub OIDC deploy role and
# deploy template.yaml (see apps/portfolio/scripts/bootstrap-infra.sh for the
# pattern), then fill RoleArn in deploy-params.json. After that, pushes to main
# deploy automatically via .github/workflows/combo-kitchen.yml. Run this script
# directly for a manual deploy.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PARAMS_FILE="deploy-params.json"

read_param() {
  python3 -c "import json; print(json.load(open('$PARAMS_FILE')).get('$1', ''))"
}

STACK_NAME="${STACK_NAME:-$(read_param StackName)}"
REGION="${REGION:-$(read_param Region)}"
STACK_NAME="${STACK_NAME:-ComboKitchen}"
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

# Cache-Control is split by mutability, not by filename. Only dist/assets/* is
# content-hashed, so only it is safe to freeze. Everything else — index.html,
# fonts — keeps its URL across deploys and must stay revalidatable. "immutable"
# tells browsers not to revalidate at all, so a CloudFront invalidation cannot
# undo it once served.
echo "Uploading hashed assets to s3://$BUCKET (immutable)…"
aws s3 sync dist/assets/ "s3://$BUCKET/assets/" --delete \
  --cache-control "public,max-age=31536000,immutable"

echo "Uploading everything else (short cache)…"
# --delete honours --exclude, so assets/ uploaded above is not pruned here.
aws s3 sync dist/ "s3://$BUCKET" --delete --exclude "assets/*" \
  --cache-control "public,max-age=60,must-revalidate"

echo "Uploading index.html (no-cache)…"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache"

echo "Invalidating CloudFront cache ($DIST_ID)…"
# "/*" is one path against the monthly free-invalidation allowance.
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo ""
echo "Deployed. Combo Kitchen is live:"
echo "   $SITE_URL"
