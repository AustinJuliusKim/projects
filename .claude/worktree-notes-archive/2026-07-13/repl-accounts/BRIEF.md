# Worker brief — guided-repl: Accounts & Progress

Worktree: `/Users/aukim/personal/projects/.claude/worktrees/repl-accounts` (branch `feature/repl-accounts-progress`, based on main).

AUTHORITATIVE SPECS (read before coding; they override code-derived assumptions):
- `/Users/aukim/personal/ObsidianVault/30-projects/Claude REPL Accounts & Progress Spec.md` (v1.1 LOCKED)
- `/Users/aukim/personal/ObsidianVault/30-projects/Claude REPL Lesson Engine Spec.md` (v1.1 LOCKED — Capture step + {{userName}} XSS constraints)
- `/Users/aukim/personal/ObsidianVault/30-projects/Claude REPL Architecture.md` (invariants)

## Architecture decision (documented deviation)
Spec assumes a Fastify backend container; repo is fully static. Build a plain Fastify app (`buildApp()` factory + `src/server.js` listener — container-ready, Dockerfile included) but deploy v1 via `@fastify/aws-lambda` + SAM behind a CloudFront `/api/*` behavior on learn.austinjuliuskim.com (needed for first-party httpOnly cookies). Preserve all portability disciplines: plain `pg`, SQL migrations in-repo, auth behind an adapter, own `users.id` PK everywhere, RLS defense-in-depth only.

## Known conflicts/tensions (pre-resolved)
1. Fixtures carry `<h1>Demo User</h1>` (seeder `services/guided-repl-seeder/src/normalizer.js:69` writes "Demo User"). Replace chain-wide with `{{userName}}` token; set DEFAULT_USER_NAME="Demo User" so anonymous rendering is byte-identical (existing e2e survives).
2. Post-assertion steps don't exist today — email capture lands after L1's grade assertion; engine change required (safe: no current lesson has steps after its assertion).
3. `progress` needs explicit `owner_type` (anon|user) discriminator; a `sessions` table (not in spec's model) is required for httpOnly cookie sessions. Both additive.
4. Append-only `wallet_ledger` needs a GDPR-delete escape hatch (per-transaction setting) for account deletion.
5. Tokenized suggestion text vs `matchPrompt`: composer submits raw text + branchId (branchId precedence already exists in fixtureTransport); typed personalized text falls into existing hint path. Acceptable.
6. e2e runs with no backend: ALL API calls fire-and-forget/offline-tolerant; guided mode never blocks on the API.
7. BYOK panel + wallet/Stripe endpoints OUT OF SCOPE (Phase B). Only the wallet_ledger schema + balance read ship.

## 2.1 Protocol (`packages/guided-repl-protocol/`)
New `interpolate.js` (exported from barrel):
- `USER_NAME_TOKEN = "{{userName}}"`, `MAX_USER_NAME_LENGTH = 30`, `DEFAULT_USER_NAME = "Demo User"`
- `USER_NAME_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'-]*$/u`
- `sanitizeUserName(raw)` → trim, collapse whitespace, truncate to 30, test regex; sanitized string or null
- `escapeHtml(s)` → `& < > " '` entities
- `interpolateUserName(text, name, {html=false})` → replaceAll token with (html ? escaped : raw) value, default DEFAULT_USER_NAME

`lessonSchema.js` — add to StepSchema union:
```js
z.object({
  type: z.literal("capture"),
  id: stepId,
  fields: z.array(z.enum(["name", "email"])).min(1),
  purposeMd: z.string().min(1),
  optional: z.boolean().default(true),
  consent: z.object({ label: z.string().min(1) }).optional(),
})
```
Tests: `test/interpolate.test.js` (escaping, cap, allowlist rejects `<script>`/emoji-only/onerror payloads, default on null/skip, token-absent passthrough, html vs text mode) + capture cases in `test/lessonSchema.test.js`.

## 2.2 Engine (`apps/guided-repl/src/engine/lessonEngine.js` + test)
- `stageMode`: `case "capture": return "instructing"`.
- New actions: `capture_submitted {stepId, values}` (only when current step; `results[stepId]={pass:true, values}` then `advanceFrom`, graduating if past end + completionSatisfied); `capture_skipped {stepId}` (only if optional; `results[stepId]={pass:true, skipped:true}`; advance).
- `assertion_evaluated`: on `pass && !atEnd` → `advanceFrom` (mirrors quiz; enables post-assertion capture).
- `railModel`: add `latestAssertionResult` (most recent assertion result at or before stepIndex) so GradeBanner stays visible on the capture step.
- Capture steps are flow steps; composer's `prompt_matched` jump-to-run already skips them — existing e2e keeps working.

## 2.3 App UI (`apps/guided-repl/src/`)
New:
- `identity/identity.js` (+test) — localStorage `gr:anonId` (crypto.randomUUID()), `gr:userName` (sanitized only); `ensureAnonId()`, `getUserName()`, `setUserName()`.
- `identity/IdentityContext.jsx` — provider in main.jsx: `{anonId, userName, setUserName, user, refreshSession}`; refreshSession = GET /api/me (silently null on failure).
- `api/client.js` — fetch wrappers, base `/api`, `credentials:"include"`, every call try/catch-swallowed: postLead, putProgress, postEvent (sendBeacon fallback), requestMagicLink, verifyMagicLink, getMe, getAccount, patchAccount, deleteAccount, logout.
- `state/progressStore.js` (+test) — localStorage mirror `gr:progress` `{[lessonId]:{status,updatedAt}}`; write-through to putProgress; hydrate/merge from server when signed in.
- `components/CaptureCard.jsx` — rail card: purposeMd via marked, name/email inputs per fields, consent checkbox (NEVER pre-checked), Save + Skip (if optional). Invalid name → inline "letters, numbers, spaces, . ' - only (30 max)". testids: capture-card, capture-name-input, capture-email-input, capture-consent, capture-submit, capture-skip.
- `components/AccountMenu.jsx` — header: signed-out "Sign in" (email → magic link, "check your email"); signed-in name/email, marketing toggle, sign out, export (/api/account/export), delete (confirm).
- `components/AuthCallback.jsx` — when `location.pathname === "/auth/callback"`; reads token_hash/type params, verifyMagicLink({tokenHash, anonId}), history.replaceState → `/`, refreshSession().
- `components/GraduationPanel.jsx` + `CompletionBadge.jsx` — in Rail when l8 graduates (`completion.next === null`): name-interpolated badge, copy-share-link, "Create your account" one-click magic link (email pre-filled if captured).

Modified:
- `App.jsx` — IdentityContext wiring; `onCapture(stepId, values, consent)` (sanitize name → setUserName; email → postLead({anonId,email,consent,source}); postEvent("capture_submitted"); dispatch capture_submitted); onCaptureSkip; events instrumentation (lesson_started on lesson ready, branch_chosen on prompt_matched, lesson_completed on graduated transition → progressStore.markCompleted); pass `userName` (plain display prop, not lesson state) to Transcript/WorkspacePane/PromptComposer; AuthCallback route branch; AccountMenu in header.
- `Rail.jsx` — CaptureCard when `currentStep?.type==="capture" && !results[id]`; GradeBanner from latestAssertionResult; GraduationPanel on final graduation; "Continue" affordance when a passed assertion is current.
- `Transcript.jsx` — text via `interpolateUserName(text, userName)` (text mode; React escapes).
- `WorkspacePane.jsx`/`FileViewer.jsx` — accept userName; source & diff views interpolate text-mode (diff both prevContent/content post-interpolation); HTML/markdown PREVIEW interpolates `{html:true}` on srcDoc input AND on files resolved by rewriteRefs (interpolate before base64). `sandbox="allow-scripts"` iframe invariant untouched.
- `PromptComposer.jsx` — display text interpolated; SUBMIT raw suggestion text + branchId (compiler/expectedPrompt contracts unchanged).
- `scripts/checkLessons.js` — new check (j): token lint — `/\{\{(?!userName\}\})/` anywhere in manifest/fixtures/snapshots fails.
- `vite.config.js` — dev proxy `/api` → `http://localhost:3001`.

## 2.4 Lessons + fixtures
- `packages/guided-repl-lessons/lessons/l1.yaml`: after `intro` insert capture-name step (fields:[name], optional:true, purposeMd "**What should your page call you?** Totally optional — it personalizes the page Claude builds in this demo."); after `grade` insert capture-email step (fields:[email], optional:true, consent label "Also send me the newsletter (occasional, unsubscribe anytime)", purposeMd "**Keep your progress + get your page link.** Drop an email and we'll save where you left off."). `completion.assertionIds` unchanged — capture never gates completion.
- Script-assisted one-off replace `Demo User` → `{{userName}}` across `apps/guided-repl/public/fixtures/v1/fixtures/**/*.json` and `snapshots/*.json` (~28 files). Uniform replace keeps chain checks consistent (incl. l7 byte-compare).
- Recompile: `npm run build` in packages/guided-repl-lessons; copy dist/lessons.json → apps/guided-repl/public/fixtures/v1/lessons.json.
- Seeder: `services/guided-repl-seeder/src/normalizer.js:69` → emit `"{{userName}}"` (+ its test).

## 2.5 Backend (`services/guided-repl-api/` — all new)
package.json: fastify, @fastify/cookie, @fastify/cors, @fastify/aws-lambda, pg, zod, @guided-repl/protocol (file:../../packages/guided-repl-protocol).
- `src/config.js` (DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_TTL_DAYS=30, COOKIE_SECRET, PUBLIC_ORIGIN)
- `src/db.js` pg Pool + withTransaction; `src/repo.js` all SQL behind functions (findUserByAuthUid/Email, createUser, upsertLead, upsertProgress, listProgress, insertEvent(s), mergeAnon(client, anonId, userId), walletBalance, createSession, findSession, deleteSession, deleteAccountData)
- `src/auth/adapter.js` JSDoc interface {issueMagicLink(email, redirectTo), verifyToken(tokenHash, type)}; `supabaseAdapter.js` (POST {SUPABASE_URL}/auth/v1/otp; POST /auth/v1/verify {type:"magiclink", token_hash} → {user:{id,email}}); `fakeAdapter.js` deterministic for tests/dev.
- `src/sessions.js` opaque token, sha256 token_hash stored; `gr_session` cookie httpOnly/Secure/SameSite=Lax/Path=/.
- `src/app.js` buildApp({repo, authAdapter, config}) — authz enforced HERE (RLS defense-in-depth only). `src/server.js` listen; `src/lambda.js` awsLambdaFastify(buildApp()).
- Routes: health; auth (POST /api/auth/magic-link {email, anonId?} also upserts lead; POST /api/auth/verify {tokenHash, type, anonId?} → upsert users(auth_uid), create session + cookie, mergeAnon in ONE tx, insert account_created event; POST /api/auth/logout; GET /api/me); leads (POST /api/leads {anonId, name?, email?, consent, source} — server re-runs sanitizeUserName, rejects invalid); progress (GET /api/progress session-or-?anonId; PUT /api/progress/:lessonId {status, assertions, anonId?}); events (POST /api/events {events:[{kind,payload}], anonId?} — kind allowlist: lesson_started|lesson_completed|branch_chosen|capture_submitted|account_created|pack_purchased); account (GET profile+progress+balance_cents; PATCH {name, marketingConsent}; GET /export JSON dump; DELETE — purge PII, anonymize events).
- `scripts/migrate.js` plain runner: applies migrations/*.sql in order, records in schema_migrations. Support `--dry-run` (parse/check only).
- Tests: node --test, app.inject() with fakeAdapter + in-memory repo stub (magic-link flow incl. merge, sanitizeUserName rejection, event-kind allowlist, cookie flags); integration suite gated on TEST_DATABASE_URL.
- template.yaml + samconfig.toml (SAM: Lambda nodejs20.x + HttpApi), Dockerfile (container parity), README runbook (env, migrate, local dev, deploy, Supabase→Aurora swap notes).

## 3 Migrations
- `0001_extensions.sql`: citext, pgcrypto.
- `0002_core.sql`: users(id uuid pk default gen_random_uuid(), auth_uid uuid unique, email citext unique not null, name text, marketing_consent bool not null default false, stripe_customer_id text, created_at timestamptz default now()); leads(id, anon_id uuid not null, name, email citext, consent bool default false, source text not null, claimed_by uuid refs users, created_at) + idx (anon_id),(email); progress(id, owner_type check in('anon','user'), owner_id uuid not null, lesson_id text, status check in('started','completed'), assertions jsonb default '{}', updated_at, unique(owner_type,owner_id,lesson_id)); events(id bigint identity pk, owner_type, owner_id uuid NULLABLE, kind text, payload jsonb, created_at) + idx; sessions(id, token_hash text unique, user_id refs users on delete cascade, created_at, expires_at).
- `0003_wallet.sql`: wallet_ledger(id bigint identity, user_id refs users, type check in('topup','usage','unlock','refund'), amount_cents int, ref text, created_at); append-only trigger — raise on UPDATE always; on DELETE unless current_setting('app.gdpr_delete', true)='on'; view wallet_balances = sum group by user_id.
- `0004_rls.sql`: enable RLS on owner-scoped tables; revoke all from anon, authenticated (kills direct client-key access; backend's postgres role unaffected).
- mergeAnon (single tx at verify): progress — delete anon rows conflicting with fresher user rows, then update owner to user; events reassigned; leads.claimed_by set.

## 4 XSS (engine spec hard rule: HTML-escape, ~30-char cap, charset allowlist, safe default)
1. Charset allowlist at capture; only sanitized value stored (localStorage + leads.name); server re-validates with the SAME protocol function.
2. 30-char truncate post-trim pre-validate.
3. HTML-escape at every markup sink (preview srcDoc, rewriteRefs-inlined files, markdown preview input) even though the allowlist blocks metacharacters (apostrophe → &#39; matters in attributes). Text sinks rely on React escaping.
4. Safe default "Demo User" on skip.
5. Interpolation render-time and client-side ONLY: reducer, virtualFs, assertions, matchPrompt, fixtures operate on the raw token. Display changes, branch doesn't. sandbox="allow-scripts" iframe (no allow-same-origin) unchanged.

## 5 Task list (one commit each; prefixes guided-repl-protocol:/guided-repl:/guided-repl-lessons:/guided-repl-api:)
1. Protocol: interpolate.js, capture step schema, barrel, tests → `cd packages/guided-repl-protocol && npm test`
2. Engine: capture actions, stageMode, mid-lesson assertion advance, latestAssertionResult, tests → `cd apps/guided-repl && npm test`
3. Interpolation threading (App → Transcript/WorkspacePane/FileViewer/PromptComposer; preview html-mode) → `npm test && npm run build`
4. Content: l1.yaml capture steps; fixture token replace; seeder normalizer + test; recompile + copy manifest; checkLessons token-lint → lessons `npm test && npm run build && npm run check`; app `npm run check:lessons && npm test`; seeder `npm test`
5. Capture UI: identity, CaptureCard, Rail wiring, App handlers; NEW `e2e/tests/capture.spec.js` (name "Ada" → preview <h1> shows Ada; `<img onerror=x>` rejected inline; skip → Demo User; email card post-grade, consent unchecked; skip → graduation); update rail.spec.js (dot count), grading/lesson1 specs (skip email capture) → `npm test && npm run e2e`
6. Backend per §2.5 + migrations §3 → `cd services/guided-repl-api && npm test`; `node scripts/migrate.js --dry-run`
7. Frontend accounts wiring: client.js, progressStore, events instrumentation, AccountMenu, AuthCallback, GraduationPanel; vite /api proxy; offline-tolerant → `npm test`; full `npm run e2e` (proves no spec depends on backend)
8. Infra/CI: CloudFront /api/* origin (param ApiOriginDomain default "" + condition; CachePolicyId 4135ea2d-6df8-44a3-9df3-4b5a84be39ad CachingDisabled; OriginRequestPolicyId b689b0a8-53d0-40ab-baf2-68738e2966ac AllViewerExceptHostHeader; AllowedMethods GET,HEAD,OPTIONS,PUT,POST,PATCH,DELETE); deploy-params.json; SAM template/Dockerfile; workflow api job + path filters → tests green everywhere; YAML parses
9. Docs: service README, protocol README (capture/interpolation); full matrix (4× npm test, lessons build+check, app build+check:lessons+e2e). DO NOT push or open a PR — report done.

## Rules
- Node 20.13; `npm ci` in linked packages first (see .github/workflows/guided-repl.yml for the symlink-deps pattern).
- Follow global CLAUDE.md: surgical diffs, no speculative abstractions, match existing style (plain ESM + JSDoc, NO TypeScript).
- Commit per task with passing verification. NEVER git push, never open PRs.
- If blocked >30 min on one issue, note it in the commit/report and move to the next independent task.

## Manual ops (NOT yours — will go in the PR "Ops tasks" section)
Supabase project creation + auth config; secrets; prod migrations; API SAM bootstrap; ApiOriginDomain fill + CloudFront redeploy; magic-link smoke; privacy policy page.
