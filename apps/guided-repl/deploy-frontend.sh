#!/usr/bin/env bash
# Build the frontend and publish it to S3 + CloudFront.
# Reads bucket name, distribution id, and site URL from the CloudFormation
# stack outputs — no manual copying needed. Params (stack name, region) come
# from deploy-params.json unless overridden via STACK_NAME/REGION env vars.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PARAMS_FILE="deploy-params.json"

read_param() {
  python3 -c "import json,sys; print(json.load(open('$PARAMS_FILE')).get('$1', ''))"
}

CERT_ARN="$(read_param CertificateArn)"
if [ "$CERT_ARN" = "FILL_AFTER_BOOTSTRAP" ]; then
  echo "ERROR: CertificateArn in $PARAMS_FILE is still 'FILL_AFTER_BOOTSTRAP'." >&2
  echo "Run scripts/bootstrap-infra.sh first, then fill in the emitted cert ARN." >&2
  exit 1
fi

STACK_NAME="${STACK_NAME:-$(read_param StackName)}"
REGION="${REGION:-$(read_param Region)}"
STACK_NAME="${STACK_NAME:-GuidedRepl}"
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
  echo "ERROR: SiteBucketName output not found. Did you deploy template.yaml with the latest stack?" >&2
  exit 1
fi

echo "Building frontend…"
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
echo "Deployed. Your web app:"
echo "   $SITE_URL"
