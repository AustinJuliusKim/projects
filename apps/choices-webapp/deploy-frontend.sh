#!/usr/bin/env bash
# Build the frontend and publish it to S3 + CloudFront.
# Reads bucket name, distribution id, API url, and VAPID key from the
# CloudFormation stack outputs — no manual copying needed.
set -euo pipefail

STACK_NAME="${STACK_NAME:-ChoicesWebApp}"

echo "Reading stack outputs from '$STACK_NAME'…"
get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

API_URL="$(get_output ApiUrl)"
VAPID_PUBLIC_KEY="$(get_output VapidPublicKey)"
BUCKET="$(get_output SiteBucketName)"
DIST_ID="$(get_output DistributionId)"
SITE_URL="$(get_output SiteUrl)"

if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "ERROR: SiteBucketName output not found. Did you run 'sam deploy' with the latest template?" >&2
  exit 1
fi

echo "Building frontend…"
( cd frontend && \
  printf 'VITE_API_URL=%s\nVITE_VAPID_PUBLIC_KEY=%s\n' "$API_URL" "$VAPID_PUBLIC_KEY" > .env && \
  npm run build )

echo "Uploading to s3://$BUCKET …"
aws s3 sync frontend/dist/ "s3://$BUCKET" --delete

echo "Invalidating CloudFront cache ($DIST_ID)…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo ""
echo "✅ Deployed. Your web app:"
echo "   $SITE_URL"
