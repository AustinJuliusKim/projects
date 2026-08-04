#!/usr/bin/env bash
# Build the frontend and publish it to S3 + CloudFront. Reads bucket name,
# distribution id, and site URL from the CloudFormation stack outputs.
# Params (stack name, region) come from deploy-params.json unless overridden
# via STACK_NAME/REGION env vars. Mirrors apps/guided-repl/deploy-frontend.sh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PARAMS_FILE="deploy-params.json"

read_param() {
  python3 -c "import json,sys; print(json.load(open('$PARAMS_FILE')).get('$1', ''))"
}

API_ORIGIN="$(read_param ApiOriginDomain)"
if [ "$API_ORIGIN" = "FILL_AFTER_API_DEPLOY" ]; then
  echo "ERROR: ApiOriginDomain in $PARAMS_FILE is still 'FILL_AFTER_API_DEPLOY'." >&2
  echo "Deploy services/mtg-api first and paste its ApiEndpoint output here." >&2
  exit 1
fi

STACK_NAME="${STACK_NAME:-$(read_param StackName)}"
REGION="${REGION:-$(read_param Region)}"
STACK_NAME="${STACK_NAME:-MtgWebapp}"
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
  echo "ERROR: SiteBucketName output not found. Deploy template.yaml first." >&2
  exit 1
fi

echo "Building…"
npm run build

echo "Syncing dist/ to s3://$BUCKET…"
aws s3 sync dist/ "s3://$BUCKET" --delete

echo "Invalidating CloudFront cache…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo "Done: $SITE_URL"
