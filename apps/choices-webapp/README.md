# Choices — Two-Player Elimination Game

Pre-seed 4 choices, share a short code, and take turns eliminating until one wins.

- The **host** creates a pairing with 4 choices and gets a join code (e.g. `PLUM-42`) to share through any messaging app.
- The **guest** enters the code and eliminates 1 choice. The host is notified.
- The **host** eliminates 1 (2 left). The guest is notified.
- The **guest** eliminates 1 (1 left) → both see the winner.

The player who picked the choices never eliminates first: elimination order is
**non-starter → starter → non-starter**. A pairing is persistent — when a game
completes, the other player can start a **rematch** with 4 new choices (the
starter alternates each game). No accounts: each seat (A/B) is claimed via the
code and guarded by a per-device `localStorage` token; claiming a seat again
from a new device takes it over. Automatic "your turn" alerts via free
**Web Push**.

## Architecture (fully serverless, free-tier friendly)

| Concern | Service |
|---|---|
| Game state | DynamoDB (KV, TTL auto-cleanup) |
| Logic | Single Lambda + Function URL |
| Notifications | Web Push (VAPID) from Lambda |
| Frontend | React + Vite static SPA on S3 + CloudFront (both provisioned by the same SAM stack) |
| In-app refresh | Polling every 3s |
| Deploy | AWS SAM |

See [docs/PLAN.md](docs/PLAN.md) for the original design doc (historical — it
predates the pairing/join-code/rematch flow).

## Prerequisites

- **Node.js 24+** (the Lambda runtime is Node 24) — `node --version`
- **AWS account** — [sign up](https://aws.amazon.com/free/) (everything here fits the free tier)
- **AWS CLI** — [install](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then `aws --version`
- **AWS SAM CLI** — [install](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), then `sam --version`

---

## Credentials & keys you'll need (read this first)

There are **two completely different kinds of secrets** in this project. Don't
confuse them:

| What | What it's for | Where it comes from | Where it goes |
|---|---|---|---|
| **AWS access keys** (Access Key ID + Secret Access Key) | Lets the CLI deploy to *your* AWS account | AWS Console → IAM | `aws configure` (stored in `~/.aws/credentials`) |
| **VAPID keys** (Public + Private) | Signs Web Push notifications | Generated locally by `web-push` (NOT from AWS) | SAM deploy params + frontend `.env` |

> 📌 **You only pull *one* thing from the AWS Console: your IAM access keys.**
> The VAPID keys are generated on your own machine. Everything else (the API
> URL, etc.) is *produced* by the deploy and printed back to you.

### Getting your AWS access keys from the Console

1. Sign in to the [AWS Console](https://console.aws.amazon.com/).
2. In the top search bar, go to **IAM**.
3. Left sidebar → **Policies** → **Create policy** → **JSON** tab. Paste the
   contents of [`docs/iam-policy.json`](iam-policy.json). Name it
   `choices-webapp-deploy` and create it.
   - This grants only what deploy needs: CloudFormation, the SAM artifact
     bucket, Lambda, the `choices-games` DynamoDB table, the frontend site
     bucket (`choiceswebapp-sitebucket-*`, created by the stack), the Lambda
     execution role, CloudWatch Logs, and CloudFront. See the note below on
     scope.
4. Left sidebar → **Users** → click your user (or **Create user** if you have
   none) → **Add permissions** → **Attach policies directly** → attach
   `choices-webapp-deploy`.
5. Open the user → **Security credentials** tab → **Create access key**.
6. Choose **Command Line Interface (CLI)**, acknowledge, **Create**.
7. Copy the **Access key ID** and **Secret access key**. ⚠️ The secret is shown
   **only once** — copy it now.

Then configure the CLI:

```bash
aws configure
# AWS Access Key ID:     <paste Access key ID>
# AWS Secret Access Key: <paste Secret access key>
# Default region name:   us-east-1     # pick your region; keep it consistent
# Default output format: json
```

Verify it works:

```bash
aws sts get-caller-identity   # should print your account ID + user ARN
```

> **On the scoped policy.** [`docs/iam-policy.json`](docs/iam-policy.json) is
> least-privilege for *this* project: resources are pinned to the
> `ChoicesWebApp` stack name, the `choices-games` table, the
> `choiceswebapp-sitebucket-*` site bucket, and `ChoicesWebApp*` Lambda/role/
> log-group names. A few actions (`cloudformation:*`, `cloudfront:*`) use
> `Resource: "*"` because those APIs don't support resource-level scoping —
> that's an AWS limitation, not an oversight. If you change the stack name or
> table name, update the matching ARNs in the policy. If a deploy ever fails
> with `AccessDenied`, the error names the exact missing action — add it to the
> relevant statement.

---

## Step 1 — Generate VAPID keys (local, one time)

These are **not** from AWS — `web-push` makes them on your machine.

```bash
cd backend && npm install
npx web-push generate-vapid-keys
```

Output looks like:

```
=======================================
Public Key:
BNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Private Key:
abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP
=======================================
```

Keep both handy. The **Public Key** goes in two places (backend + frontend);
the **Private Key** goes only in the backend (never ship it to the browser).

---

## Step 2 — Deploy the stack (backend + frontend hosting)

```bash
# from the app root
sam build
sam deploy --guided
```

One stack provisions everything: the DynamoDB table, the Lambda + Function
URL, **and** the frontend hosting — a private S3 bucket served via CloudFront
(HTTPS, Origin Access Control, SPA fallback), with optional custom domain.

The guided prompts and what to answer:

| Prompt | Answer |
|---|---|
| `Stack Name` | `ChoicesWebApp` |
| `AWS Region` | same region you set in `aws configure` (e.g. `us-west-2`) |
| `Parameter VapidPublicKey` | the **Public Key** from Step 1 |
| `Parameter VapidPrivateKey` | the **Private Key** from Step 1 |
| `Parameter VapidSubject` | `mailto:you@example.com` (use your email) |
| `Parameter CorsAllowOrigin` | `*` for now (tighten to your site URL after Step 3) |
| `Parameter CustomDomain` | blank for the CloudFront URL, or your domain (e.g. `choices.example.com`) |
| `Parameter CertificateArn` | blank, or an ACM cert ARN for the custom domain — the cert must be in **us-east-1** (CloudFront requirement) even if the stack is elsewhere |
| `Confirm changes before deploy` | `y` |
| `Allow SAM CLI IAM role creation` | `y` |
| `Disable rollback` | `n` |
| `...may not have authorization...Function Url` | `y` |
| `Save arguments to configuration file` | `y` (saves to `samconfig.toml` so future deploys are just `sam deploy`) |

When it finishes it prints an **Outputs** table: `ApiUrl`, `VapidPublicKey`,
`SiteBucketName`, `SiteUrl`, `DistributionId`, `DistributionDomainName`.
You don't need to copy any of them — the deploy script in Step 3 reads them
from CloudFormation. `SiteUrl` is your app; if you set a custom domain, point
a DNS CNAME/alias at `DistributionDomainName`.

> You can always see these later in **AWS Console → CloudFormation →
> `ChoicesWebApp` stack → Outputs tab**.

---

## Step 3 — Deploy the frontend

```bash
cd frontend && npm install && cd ..   # first time only
./deploy-frontend.sh
```

The script reads the stack outputs, writes `frontend/.env` (`VITE_API_URL`,
`VITE_VAPID_PUBLIC_KEY`) for you, builds, syncs `dist/` to the site bucket,
and invalidates the CloudFront cache. Re-run it after any frontend change.
It defaults to stack `ChoicesWebApp`; override with `STACK_NAME=... ./deploy-frontend.sh`.

Manual equivalent, if you ever need it:

```bash
cd frontend && npm run build
aws s3 sync dist/ s3://<SiteBucketName> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

### Lock down CORS (recommended)

Once the site works, re-deploy the backend with `CorsAllowOrigin` set to your
site origin instead of `*`:

```bash
sam deploy --parameter-overrides CorsAllowOrigin=https://<your SiteUrl domain>
```

> ⚠️ Always test against the **HTTPS site URL** (CloudFront or your custom
> domain), not the S3 URL — Web Push silently does nothing over plain HTTP.

---

## Automatic deploys (CI/CD)

Pushes to `main` that touch `apps/choices-webapp/**` auto-deploy the full
stack via GitHub Actions (`.github/workflows/choices-webapp.yml`): after the
tests and build pass, the `deploy` job runs `sam build && sam deploy` and then
`./deploy-frontend.sh`. It authenticates via GitHub OIDC, assuming the IAM
role `choices-webapp-github-deploy` (trusted only for pushes to `main` of this
repo; permissions in `docs/iam-policy.json`). The manual steps above are still
how you do the first-time guided setup or deploy from your machine.

---

## Where to find things later (quick reference)

| You need… | Console location |
|---|---|
| The API URL (`ApiUrl`) | CloudFormation → `ChoicesWebApp` → Outputs |
| Your VAPID public key | CloudFormation → `ChoicesWebApp` → Outputs, or your saved key |
| Game data | DynamoDB → Tables → `choices-games` → Explore items |
| Lambda logs (debug push/errors) | CloudWatch → Log groups → `/aws/lambda/ChoicesWebApp-*` |
| CloudFront distribution ID | CloudFormation → `ChoicesWebApp` → Outputs (`DistributionId`) |
| Tear everything down | Empty the site bucket (`aws s3 rm s3://<SiteBucketName> --recursive`), then CloudFormation → delete the stack (it owns the bucket and the CloudFront distribution) |

## Local development

```bash
# Frontend dev server (point VITE_API_URL at the deployed Lambda URL)
cd frontend && npm run dev
```

Run the backend logic tests:

```bash
cd backend && npm test
```

## iOS note

Web Push on iPhone only works when the page is **added to the Home Screen**
(iOS 16.4+). The play screen shows a one-time hint. Without it, the game still
works fully via 3-second polling — players just won't get a buzz.

## Project layout

```
template.yaml        SAM: DynamoDB + Lambda (Function URL) + S3/CloudFront hosting
deploy-frontend.sh   Build + publish the frontend from stack outputs
backend/
  handler.mjs        Lambda: createPairing | claimSeat | getState | eliminate | rematch | subscribe
  game.mjs           Pure turn/elimination/winner logic
  game.test.mjs      Unit tests (node --test)
  push.mjs           web-push helper
frontend/
  src/               React app (Landing, CreatePairingView, JoinView, PlayView,
                     IosInstallHint, api, push, storage)
  public/            manifest.json, sw.js, icons
docs/PLAN.md         Original design doc (historical)
docs/iam-policy.json Least-privilege deploy policy
```
