# Stripe on the preview stack (Test Sandbox)

How to make the **preview** stack (`ChoicesWebApp-preview`,
`https://d3r33durbg7s1k.cloudfront.net`) fully exercise payment features —
checkout, the in-app cancel flow, and webhooks — against Stripe's **Test
Sandbox**. Prod's Live-mode equivalents are separate (see the end).

## What's already wired

- **Test-mode price IDs** are committed in `samconfig.toml` `[preview]`
  (`StripePriceMonthly` / `StripePriceAnnual`, the `price_1TpzG…` values).
- The **webhook route** is live on every stack: CloudFront `/api*` forwards
  `POST /api/stripe-webhook` to the Lambda. Preview URL:
  `https://d3r33durbg7s1k.cloudfront.net/api/stripe-webhook`.
- **Cognito** preview pool (`choices-auth-preview`) is enabled — sign-in works.

## What you must set (one-time)

The two secrets are **not** in git (they're `NoEcho` params). CI injects them
from GitHub, so once these are set every preview deploy is self-healing.

### 1. Register a Test-mode webhook endpoint in Stripe
Stripe Dashboard → **toggle Test mode** → Developers → Webhooks → *Add endpoint*:
- **URL:** `https://d3r33durbg7s1k.cloudfront.net/api/stripe-webhook`
- **Events:** `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`
- After creating it, copy the **Signing secret** (`whsec_…`).

### 2. Confirm the test prices exist
In Test mode, verify `price_1TpzGYIVveMhKb5YH2DIAGcr` (monthly) and
`price_1TpzGjIVveMhKb5YRATUAc1o` (annual) exist in the **same** test account as
your `sk_test_` key. If not, create test prices and update `samconfig.toml`
`[preview]` **and** the `deploy-preview` step in
`.github/workflows/choices-webapp.yml` (they must stay in sync — see note below).

### 3. Add the GitHub secrets/vars
Repo → Settings → Secrets and variables → **Actions**:
- Secret **`PREVIEW_STRIPE_SECRET_KEY`** = your `sk_test_…` key
- Secret **`PREVIEW_STRIPE_WEBHOOK_SECRET`** = the `whsec_…` from step 1
- Variable (or secret) **`PREVIEW_ADMIN_SUBS`** = your **preview-pool** Cognito
  `sub` (see below) — enables the owner-only `adminSetPremium` on preview. A
  sub isn't sensitive, so a repo **variable** is fine; the workflow reads
  `vars.PREVIEW_ADMIN_SUBS` with a `secrets.` fallback, so either works.

### 4. Find your preview Cognito `sub`
The preview user pool is separate from prod, so your `sub` differs. Sign in on
the preview site, then in the browser console:
```js
JSON.parse(atob(JSON.parse(localStorage["choices:session"]).idToken.split(".")[1])).sub
```
(or read it from the Cognito console → preview user pool → Users). Put that
value in `PREVIEW_ADMIN_SUBS`.

### 5. Trigger a preview deploy
Push any commit to an open choices-webapp PR. The `deploy-preview` job runs
`sam deploy` with `--parameter-overrides` that now include the two Stripe
secrets + `AdminSubs`.

## Test the flows

1. Sign in on preview → open **My games**. `getMe` returns
   `billingAvailable: true` once `STRIPE_SECRET_KEY` is set → the pay buttons
   render.
2. **Checkout:** click `$2.99/mo`, pay with test card `4242 4242 4242 4242`
   (any future expiry, any CVC, any ZIP). On return, the webhook flips you to
   Premium and the **badge** replaces the pay buttons (`stripeSubId` is set).
3. **Cancel:** badge → *Cancel subscription* → the Choicey page → *Confirm
   cancel*. Expect a clean "Premium until …" (Stripe `cancel_at_period_end`).
4. **Self-grant (no checkout):** with `PREVIEW_ADMIN_SUBS` set, use the
   AdminView "Premium tools" control — `adminSetPremium` reconciles your test
   customer/sub by email.

## Troubleshooting the cancel "internal error"

A **500** meant a Stripe SDK error was unhandled. That's now mapped to clean
statuses, and cancel auto-reconciles a stale sub id by email once before
failing. Remaining causes and fixes:
- **`STRIPE_AUTH` (502):** the preview `sk_test_` key is a placeholder/stale/
  wrong-mode value — re-set `PREVIEW_STRIPE_SECRET_KEY` and redeploy.
- **`NO_SUBSCRIPTION` (400):** no test subscription is linked and none matches
  your email in Stripe test mode — do a test checkout (step 2), or run
  `adminSetPremium`.
- **Premium never appears after checkout:** the test webhook endpoint isn't
  registered or its `whsec_` doesn't match `PREVIEW_STRIPE_WEBHOOK_SECRET`
  (webhook posts 400 on a bad signature). Re-check step 1/3.

## Note on the CI parameter block

`--parameter-overrides` on the SAM CLI **replaces** (does not merge)
`samconfig.toml`'s `[preview]` list, so the `deploy-preview` step repeats the
non-secret preview params alongside the injected secrets. **Keep that block in
sync with `samconfig.toml` `[preview]`** when either changes.

## Prod (Live mode) — separate

Prod's `StripeSecretKey`/`StripeWebhookSecret` are **Live** values held in the
`ChoicesWebApp` stack (never in git/CI), seeded once via a manual
`sam deploy --parameter-overrides …`. The prod Live webhook endpoint
(`https://choices.austinjuliuskim.com/api/stripe-webhook`) and its `whsec_` are
registered in Stripe **Live** mode. Do not put Live keys in GitHub Actions.
