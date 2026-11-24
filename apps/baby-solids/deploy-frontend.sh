#!/usr/bin/env bash
# Builds and publishes the baby-solids frontend to the stack's S3 bucket,
# then invalidates CloudFront. Reads stack outputs rather than taking
# arguments, so it can't publish to the wrong bucket.
#
# Mirrors apps/mtg-webapp/deploy-frontend.sh, with guided-repl's split cache
# strategy: hashed assets are immutable, index.html must never be cached or a
# deploy takes an hour to become visible.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PARAMS_FILE="deploy-params.json"

read_param() {
  python3 -c "import json,sys; print(json.load(open('$PARAMS_FILE')).get('$1', ''))"
}

GOOGLE_CLIENT_ID="$(read_param GoogleClientId)"
if [ "$GOOGLE_CLIENT_ID" = "FILL_AFTER_OAUTH_CLIENT" ]; then
  echo "ERROR: GoogleClientId in $PARAMS_FILE is still 'FILL_AFTER_OAUTH_CLIENT'." >&2
  echo "Create the Google OAuth client first (row H-1), then paste its id here." >&2
  exit 1
fi

STACK_NAME="${STACK_NAME:-$(read_param StackName)}"
REGION="${REGION:-$(read_param Region)}"
STACK_NAME="${STACK_NAME:-BabySolids}"
REGION="${REGION:-us-west-2}"

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

# The file:-linked @baby/core package is symlinked; the vite build resolves
# its imports (zod) through the symlink's real path, so the package's own
# node_modules must be populated here.
npm ci --prefix ../../packages/baby-core

echo "Building…"
export VITE_SYNC_BUCKET="$(get_output SyncBucketName)"
export VITE_IDENTITY_POOL_ID="$(get_output IdentityPoolId)"
export VITE_HOUSEHOLD_ID="$(get_output HouseholdId)"
export VITE_GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID"
export VITE_AWS_REGION="$REGION"
npm run build

echo "Syncing dist/ to s3://$BUCKET…"
aws s3 sync dist/ "s3://$BUCKET" --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude index.html --exclude manifest.webmanifest
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --cache-control "no-cache"
aws s3 cp dist/manifest.webmanifest "s3://$BUCKET/manifest.webmanifest" --cache-control "no-cache"

echo "Invalidating CloudFront cache…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/index.html" "/manifest.webmanifest" >/dev/null

echo "Done: $SITE_URL"
