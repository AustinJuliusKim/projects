#!/usr/bin/env bash
# One-time admin bootstrap for the portfolio deploy surfaces:
#   a) find (or request) an ACM cert for the apex domain in us-east-1
#   b) auto-detect a Route53 hosted zone for the apex domain; upsert the
#      validation record (and, after stack creation, the alias record) if
#      found, otherwise print the records for manual entry at the DNS provider
#   c) wait for the cert to reach ISSUED
#   d) create/update the IAM role used by GitHub Actions OIDC deploys
#   e) deploy the CloudFormation stack with the cert ARN
#   f) print the values to confirm in deploy-params.json + the workflow
#
# Idempotent: safe to re-run. Requires admin AWS credentials
# (e.g. `aws login --profile admin` then `AWS_PROFILE=admin ./bootstrap-infra.sh`).
#
# Usage: ./bootstrap-infra.sh [--dry-run]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

STACK_NAME="Portfolio"
REGION="us-west-2"
CERT_REGION="us-east-1"
DOMAIN="austinjuliuskim.com"       # apex — the site lives at the root domain
APEX_DOMAIN="austinjuliuskim.com"
REPO="AustinJuliusKim/projects"
ROLE_NAME="portfolio-github-deploy"
IAM_POLICY_FILE="docs/iam-policy.json"

run() {
  echo "+ $*"
  if [ "$DRY_RUN" = true ]; then
    echo "  (dry-run: skipped)"
    return 0
  fi
  "$@"
}

echo "== portfolio bootstrap =="
echo "Stack:  $STACK_NAME ($REGION)"
echo "Domain: $DOMAIN"
echo "Repo:   $REPO"
echo "Dry run: $DRY_RUN"
echo ""

# --- (a) ACM certificate (us-east-1) ---------------------------------------

echo "-- (a) ACM certificate --"
EXISTING_CERT_ARN="$(aws acm list-certificates --region "$CERT_REGION" \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" \
  --output text 2>/dev/null || true)"

if [ -n "$EXISTING_CERT_ARN" ] && [ "$EXISTING_CERT_ARN" != "None" ]; then
  CERT_ARN="$EXISTING_CERT_ARN"
  echo "Found existing certificate: $CERT_ARN"
else
  if [ "$DRY_RUN" = true ]; then
    echo "+ aws acm request-certificate --domain-name $DOMAIN --validation-method DNS --region $CERT_REGION"
    echo "  (dry-run: skipped)"
    CERT_ARN="arn:aws:acm:us-east-1:PENDING:certificate/dry-run"
  else
    CERT_ARN="$(aws acm request-certificate \
      --domain-name "$DOMAIN" \
      --validation-method DNS \
      --region "$CERT_REGION" \
      --query CertificateArn --output text)"
    echo "Requested certificate: $CERT_ARN"
  fi
fi

# --- (b) Route53 zone auto-detect + DNS validation record ------------------

echo ""
echo "-- (b) Route53 hosted zone detection --"
HOSTED_ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name "$APEX_DOMAIN." \
  --query "HostedZones[?Name=='${APEX_DOMAIN}.'].Id | [0]" --output text 2>/dev/null || true)"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID#/hostedzone/}"

if [ -n "$HOSTED_ZONE_ID" ] && [ "$HOSTED_ZONE_ID" != "None" ]; then
  echo "Found Route53 hosted zone for $APEX_DOMAIN: $HOSTED_ZONE_ID"

  if [ "$DRY_RUN" = true ]; then
    echo "+ aws acm describe-certificate --certificate-arn $CERT_ARN (to fetch validation record)"
    echo "  (dry-run: skipped)"
  else
    VALIDATION_NAME="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$CERT_REGION" \
      --query "Certificate.DomainValidationOptions[0].ResourceRecord.Name" --output text)"
    VALIDATION_TYPE="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$CERT_REGION" \
      --query "Certificate.DomainValidationOptions[0].ResourceRecord.Type" --output text)"
    VALIDATION_VALUE="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$CERT_REGION" \
      --query "Certificate.DomainValidationOptions[0].ResourceRecord.Value" --output text)"

    if [ "$VALIDATION_NAME" != "None" ] && [ -n "$VALIDATION_NAME" ]; then
      CHANGE_BATCH="$(python3 -c "
import json
print(json.dumps({
  'Changes': [{
    'Action': 'UPSERT',
    'ResourceRecordSet': {
      'Name': '$VALIDATION_NAME',
      'Type': '$VALIDATION_TYPE',
      'TTL': 300,
      'ResourceRecords': [{'Value': '$VALIDATION_VALUE'}],
    },
  }],
}))
")"
      echo "+ aws route53 change-resource-record-sets --hosted-zone-id $HOSTED_ZONE_ID --change-batch <validation record upsert>"
      aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
        --change-batch "$CHANGE_BATCH" >/dev/null
      echo "Upserted validation record."
    else
      echo "Certificate already validated (no pending validation record)."
    fi
  fi
else
  echo "No Route53 hosted zone found for $APEX_DOMAIN in this account."
  echo "Add the ACM validation record manually at your DNS provider:"
  if [ "$DRY_RUN" = false ]; then
    aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$CERT_REGION" \
      --query "Certificate.DomainValidationOptions[0].ResourceRecord" --output table || true
  fi
  HOSTED_ZONE_ID=""
fi

# --- (c) wait for cert ISSUED -----------------------------------------------

echo ""
echo "-- (c) waiting for certificate validation --"
if [ "$DRY_RUN" = true ]; then
  echo "+ aws acm wait certificate-validated --certificate-arn $CERT_ARN"
  echo "  (dry-run: skipped)"
else
  echo "This can take several minutes once DNS has propagated. Waiting…"
  aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region "$CERT_REGION"
  echo "Certificate ISSUED: $CERT_ARN"
fi

# --- (d) IAM role for GitHub Actions OIDC deploys ---------------------------

echo ""
echo "-- (d) IAM role: $ROLE_NAME --"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
OIDC_PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" >/dev/null 2>&1; then
  echo "ERROR: GitHub Actions OIDC provider not found in this account:" >&2
  echo "  $OIDC_PROVIDER_ARN" >&2
  echo "" >&2
  echo "Create it first (one-time per account), e.g.:" >&2
  echo "  aws iam create-open-id-connect-provider \\" >&2
  echo "    --url https://token.actions.githubusercontent.com \\" >&2
  echo "    --client-id-list sts.amazonaws.com \\" >&2
  echo "    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1" >&2
  exit 1
fi
echo "Found OIDC provider: $OIDC_PROVIDER_ARN"

TRUST_POLICY="$(python3 -c "
import json
print(json.dumps({
  'Version': '2012-10-17',
  'Statement': [{
    'Effect': 'Allow',
    'Principal': {'Federated': '$OIDC_PROVIDER_ARN'},
    'Action': 'sts:AssumeRoleWithWebIdentity',
    'Condition': {
      'StringEquals': {'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'},
      'StringLike': {'token.actions.githubusercontent.com:sub': 'repo:$REPO:ref:refs/heads/main'},
    },
  }],
}))
")"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME exists — updating trust policy."
  run aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY"
else
  run aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "GitHub Actions OIDC deploy role for portfolio (repo: $REPO)"
fi

run aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name portfolio-deploy \
  --policy-document "file://$IAM_POLICY_FILE"

if [ "$DRY_RUN" = true ]; then
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
else
  ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"
fi
echo "Role ARN: $ROLE_ARN"

# --- (e) deploy the CloudFormation stack ------------------------------------

echo ""
echo "-- (e) deploying stack $STACK_NAME --"
run aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --parameter-overrides "CustomDomain=$DOMAIN" "CertificateArn=$CERT_ARN" \
  --no-fail-on-empty-changeset

if [ "$DRY_RUN" = true ]; then
  DIST_DOMAIN="dPENDING.cloudfront.net"
else
  DIST_DOMAIN="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text)"
fi
echo "CloudFront domain: $DIST_DOMAIN"

# --- apex alias record (Route53) or manual instructions --------------------

echo ""
echo "-- alias record for $DOMAIN --"
if [ -n "$HOSTED_ZONE_ID" ] && [ "$HOSTED_ZONE_ID" != "None" ]; then
  ALIAS_CHANGE_BATCH="$(python3 -c "
import json
print(json.dumps({
  'Changes': [{
    'Action': 'UPSERT',
    'ResourceRecordSet': {
      'Name': '$DOMAIN',
      'Type': 'A',
      'AliasTarget': {
        'HostedZoneId': 'Z2FDTNDATAQYW2',
        'DNSName': '$DIST_DOMAIN',
        'EvaluateTargetHealth': False,
      },
    },
  }],
}))
")"
  echo "+ aws route53 change-resource-record-sets --hosted-zone-id $HOSTED_ZONE_ID --change-batch <apex alias A record upsert>"
  run aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "$ALIAS_CHANGE_BATCH" >/dev/null
  echo "Upserted apex alias record: $DOMAIN -> $DIST_DOMAIN"
else
  echo "No Route53 hosted zone — the apex domain needs an ALIAS/ANAME (not CNAME)."
  echo "Point $DOMAIN at: $DIST_DOMAIN (apex-alias support required, or move DNS to Route53)."
fi

# --- (f) values to confirm ---------------------------------------------------

echo ""
echo "== bootstrap complete =="
echo "Confirm these in apps/portfolio/deploy-params.json:"
echo "  CertificateArn: $CERT_ARN"
echo "  RoleArn:        $ROLE_ARN"
echo ""
echo "The role ARN is hardcoded in .github/workflows/portfolio.yml"
echo "(arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}) — confirm it matches: $ROLE_ARN"
