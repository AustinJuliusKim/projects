# Choices — Two-Player Elimination Game

Pre-seed 4 choices, share a link, and take turns eliminating until one wins.

- **User A** creates a game with 4 choices and shares the link.
- **User B** opens the link and eliminates 1 choice. A is notified.
- **User A** eliminates 1 (2 left). B is notified.
- **User B** eliminates 1 (1 left) → both see the winner.

Turn order: **B → A → B**. Automatic "your turn" alerts via free **Web Push**.

## Architecture (fully serverless, free-tier friendly)

| Concern | Service |
|---|---|
| Game state | DynamoDB (KV, TTL auto-cleanup) |
| Logic | Single Lambda + Function URL |
| Notifications | Web Push (VAPID) from Lambda |
| Frontend | React + Vite static SPA on S3 + CloudFront |
| In-app refresh | Polling every 3s |
| Deploy | AWS SAM |

See [docs/PLAN.md](docs/PLAN.md) for the full design.

## Prerequisites

- **Node.js 20+** — `node --version`
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
   contents of [`docs/iam-policy.json`](iam-policy.json), then **before saving**
   replace `your-unique-choices-bucket` (in the `FrontendHostingBucket`
   statement) with the bucket name you'll use in Step 4. Name it
   `choices-webapp-deploy` and create it.
   - This grants only what deploy needs: CloudFormation, the SAM artifact
     bucket, Lambda, the `choices-games` DynamoDB table, the Lambda execution
     role, CloudWatch Logs, and CloudFront. See the note below on scope.
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
> `choices-webapp` stack name, the `choices-games` table, and `choices-webapp*`
> Lambda/role/log-group names. A few actions (`cloudformation:*`,
> `cloudfront:*`) use `Resource: "*"` because those APIs don't support
> resource-level scoping — that's an AWS limitation, not an oversight. If you
> change the stack name, table name, or bucket name, update the matching ARNs in
> the policy. If a deploy ever fails with `AccessDenied`, the error names the
> exact missing action — add it to the relevant statement.

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

## Step 2 — Deploy the backend (DynamoDB + Lambda)

```bash
# from the repo root
sam build
sam deploy --guided
```

The guided prompts and what to answer:

| Prompt | Answer |
|---|---|
| `Stack Name` | `choices-webapp` |
| `AWS Region` | same region you set in `aws configure` (e.g. `us-east-1`) |
| `Parameter VapidPublicKey` | the **Public Key** from Step 1 |
| `Parameter VapidPrivateKey` | the **Private Key** from Step 1 |
| `Parameter VapidSubject` | `mailto:you@example.com` (use your email) |
| `Parameter CorsAllowOrigin` | `*` for now (tighten to your CloudFront URL after Step 4) |
| `Confirm changes before deploy` | `y` |
| `Allow SAM CLI IAM role creation` | `y` |
| `Disable rollback` | `n` |
| `...may not have authorization...Function Url` | `y` |
| `Save arguments to configuration file` | `y` (saves to `samconfig.toml` so future deploys are just `sam deploy`) |

When it finishes it prints an **Outputs** table. **Copy these two values:**

```
Key              ApiUrl
Value            https://abc123xyz.lambda-url.us-east-1.on.aws/

Key              VapidPublicKey
Value            BNxxxxxxxx...
```

> You can always see these later in **AWS Console → CloudFormation →
> `choices-webapp` stack → Outputs tab**.

---

## Step 3 — Build & configure the frontend

```bash
cd frontend
npm install
cp .env.example .env
```

Edit `.env` with the values from Step 2's outputs:

```ini
VITE_API_URL=https://abc123xyz.lambda-url.us-east-1.on.aws/
VITE_VAPID_PUBLIC_KEY=BNxxxxxxxx...
```

Then build:

```bash
npm run build   # static site -> frontend/dist/
```

---

## Step 4 — Host the frontend (S3 + CloudFront)

Web Push and service workers **require HTTPS**, so the static site must be
served via CloudFront (raw S3 website hosting is HTTP-only and won't work).

### 4a. Create the bucket and upload

```bash
# bucket names are globally unique — pick your own
aws s3 mb s3://your-unique-choices-bucket
aws s3 sync frontend/dist/ s3://your-unique-choices-bucket --delete
```

### 4b. Create the CloudFront distribution (Console)

1. AWS Console → **CloudFront** → **Create distribution**.
2. **Origin domain**: select your S3 bucket.
3. **Origin access**: choose **Origin access control settings (recommended)**,
   then **Create control setting** (accept defaults). CloudFront will show a
   policy snippet — click **Copy policy** and paste it into the bucket policy
   when prompted (this lets CloudFront read the private bucket).
4. **Viewer protocol policy**: **Redirect HTTP to HTTPS**.
5. **Default root object**: `index.html`.
6. Create the distribution. Note its **Distribution domain name**
   (e.g. `d123abc.cloudfront.net`) and its **Distribution ID**.

### 4c. SPA routing fallback

This is a single-page app using hash routes, so deep links work without extra
config. But to be safe, add a **Custom error response** on the distribution:
**HTTP error code 403 → Response page path `/index.html` → HTTP 200**.

### 4d. (Optional) Lock down CORS

Re-deploy the backend with `CorsAllowOrigin` set to your CloudFront URL instead
of `*`:

```bash
sam deploy --parameter-overrides CorsAllowOrigin=https://d123abc.cloudfront.net
```

### 4e. Redeploying later

Each time you change the frontend:

```bash
cd frontend && npm run build
aws s3 sync dist/ s3://your-unique-choices-bucket --delete
aws cloudfront create-invalidation --distribution-id <Distribution ID> --paths "/*"
```

> ⚠️ Always test against the **CloudFront HTTPS URL**, not the S3 URL — Web Push
> silently does nothing over plain HTTP.

---

## Where to find things later (quick reference)

| You need… | Console location |
|---|---|
| The API URL (`ApiUrl`) | CloudFormation → `choices-webapp` → Outputs |
| Your VAPID public key | CloudFormation → `choices-webapp` → Outputs, or your saved key |
| Game data | DynamoDB → Tables → `choices-games` → Explore items |
| Lambda logs (debug push/errors) | CloudWatch → Log groups → `/aws/lambda/choices-webapp-*` |
| CloudFront distribution ID | CloudFront → Distributions |
| Tear everything down | CloudFormation → delete the stack; then empty + delete the S3 bucket and the CloudFront distribution |

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
template.yaml        SAM: DynamoDB + Lambda + Function URL
backend/
  handler.mjs        Lambda: createGame | getGame | eliminate | subscribe
  game.mjs           Pure turn/elimination/winner logic
  game.test.mjs      Unit tests (node --test)
  push.mjs           web-push helper
frontend/
  src/               React app (CreateView, PlayView, api, push, storage)
  public/            manifest.json, sw.js, icons
docs/PLAN.md         Full design doc
```
