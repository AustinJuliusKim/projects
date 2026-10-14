# Auth + RBAC plan (tcg-pos-api)

Status: approved direction 2026-10-14. Identity = AWS Cognito (Lite tier, its own
pool, defined in `template.yaml` but **not deployed** — everything stays local
until the hosting decision). Authorization = Postgres tables, resolved per
request inside the existing RLS transaction. Research and alternatives: vault
note *TCG Store POS* → Decision log.

## Principles
1. **The token proves who; the database decides what.** The access token is used
   only for `sub`. Tenant membership, role and permissions are read from Postgres
   on every request, so revocation is instant and no claim can go stale.
2. **One code path in every environment.** No header bypass. Locally, a dev
   issuer (an RSA key pair under `.dev/auth/`, gitignored) signs RS256 tokens
   with the same shape as Cognito access tokens; the verifier is configured with
   its JWKS instead of Cognito's. `scripts/dev_token.py` mints tokens, and
   `POST /v1/dev/login` exists **only** when `AUTH_ISSUER` is the dev issuer.
   The app refuses to start with the dev issuer when `ENV` isn't `local`/`test`.
3. **The database owns the actor.** Ledger and audit `actor` columns default to
   `current_setting('app.actor')`, and a trigger rejects any other value for
   rows written as `tcg_pos_app`. Routes cannot forge who did something.
4. **Every non-public route declares a permission.** A test walks `app.routes`
   and fails if one doesn't.

## Token verification (`tcg_pos_api/auth/tokens.py`)
- PyJWT + `PyJWKClient` at module level (keys cached across warm Lambda
  invocations; refetch on unknown `kid`).
- `algorithms=["RS256"]` pinned; `iss == AUTH_ISSUER`; `token_use == "access"`;
  `client_id in AUTH_CLIENT_IDS`; `exp` with 30 s leeway. Cognito access tokens
  have no `aud` — don't require one.
- Config: `AUTH_ISSUER`, `AUTH_CLIENT_IDS` (comma list), `AUTH_JWKS_URL`
  (defaults to `{issuer}/.well-known/jwks.json`; the dev issuer points at a file).

## Request principal
`X-Tenant-Id` stays, but only as a **selector** ("which of my stores"); it is
never trusted on its own. `_tenant_conn` becomes:
1. Verify the bearer token → `sub`. (Register requests: device + session tokens
   instead — see below.)
2. `SET LOCAL ROLE tcg_pos_app`; `set_config('app.tenant_id', selector, true)`.
3. `SELECT * FROM resolve_principal(sub, tenant)` — SECURITY DEFINER, returns
   `user_id, role_key, perms text[], location_ids uuid[]` for an active
   membership, or no row → **403** (same response whether the store exists or not).
4. `set_config` for `app.user_id`, `app.actor`, `app.perms` (comma list),
   `app.approved_by` (when an approval was consumed).
5. Routes depend on `require(Perm.X)`, which reads the principal and raises 403
   `{"detail": {"missing": "pos.refund"}}`.

Actor strings: `user:<uuid>`, `device:<uuid>/user:<uuid>`, `apikey:<uuid>`,
`job:<name>`, `storefront:<slug>`.

## Schema (migrations 0011–0013)
**0011_rbac.sql**
- `app_user(id, cognito_sub UNIQUE, email, display_name, created_at)` — global,
  not tenant-scoped; `tcg_pos_app` has no direct grants, only definer functions.
- `permission(key PRIMARY KEY, description)` seeded from the list below; a test
  asserts it equals the Python `Perm` enum.
- `role(id, tenant_id NULL = system role, key, name, is_system)`,
  `role_permission(role_id, perm REFERENCES permission)`.
- `membership(tenant_id, user_id, role_id, location_id NULL = all locations,
  status active|disabled, invited_by, created_at)`, UNIQUE(tenant_id, user_id).
  RLS by tenant. (Location-scoped rows are Phase 5; the column exists now.)
- `invite(id, tenant_id, email, role_id, token_hash, expires_at, accepted_at,
  invited_by, created_at)`.
- Functions: `resolve_principal(sub, tenant)`, `ensure_app_user(sub, email)`,
  `my_stores(sub)`, `accept_invite(sub, email, token_hash)`,
  `create_store(sub, email, name)` (onboarding: tenant + location + owner
  membership in one transaction).
- Actor: `DEFAULT current_setting('app.actor', true)` on `inventory_ledger`,
  `credit_ledger`, `audit_log` (+ any other actor columns), and a BEFORE INSERT
  trigger that raises when `current_user = 'tcg_pos_app'` and the value differs
  from `app.actor`. Add `approved_by uuid` to `audit_log` and `credit_ledger`
  and `inventory_ledger`, defaulted from `app.approved_by`.
- Backfill script `scripts/backfill_owner.py --tenant <id> --sub <sub> --email`
  for existing local tenants (the demo store).

**0012_register_auth.sql**
- `register_device(id, tenant_id, register_id, secret_hash, enrolled_by,
  enrolled_at, last_seen_at, revoked_at)`.
- `staff_pin(tenant_id, user_id, pin_hash, fail_count, locked_until, updated_at)`.
- `register_session(id, tenant_id, device_id, user_id, token_hash, created_at,
  expires_at, last_seen_at, ended_at)`.
- `approval_policy(tenant_id, role_id, perm, mode allow|approval|deny,
  limit_cents)` — absent row = the role's plain permission decides.
- `approval(id, tenant_id, perm, payload_hash, amount_cents, requested_by,
  approved_by, device_id, created_at, expires_at, consumed_at)`.

**0013_api_keys.sql**
- `api_key(id, tenant_id, name, prefix, secret_hash, perms text[], created_by,
  created_at, last_used_at, revoked_at)`; header `Authorization: ApiKey
  tcgpos_<prefix>_<secret>`; perms must be a subset of the creator's.

## Permissions
`pos.sell` `pos.discount` `pos.price_override` `pos.refund` `pos.void`
`pos.drawer_open` · `credit.read` `credit.issue` `credit.adjust` ·
`buylist.create` `buylist.payout_credit` `buylist.payout_cash` ·
`inventory.read` `inventory.adjust` `inventory.price_edit` `pricing.rules_manage`
`imports.run` · `web_orders.read` `web_orders.fulfill` `storefront.manage` ·
`customers.read` `customers.manage` · `reports.view` `audit.read` ·
`staff.manage` `roles.manage` `registers.manage` `apikeys.manage`
`channels.manage` `settings.manage` `billing.manage` · `approve.override`

Map every existing route to one of these (POS sale/refund routes don't exist
yet — the perms are seeded for them).

Default system roles:
| Role | Grants |
|---|---|
| owner | everything; ≥1 per tenant, can't be removed or demoted if last |
| manager | everything except `billing.manage`, `roles.manage`, `channels.manage`, `apikeys.manage`; has `approve.override` |
| buyer | `buylist.*`, `inventory.*`, `pricing.rules_manage`? no — `inventory.read/adjust/price_edit`, `imports.run`, `credit.read/issue`, `customers.read`, `pos.sell` |
| cashier | `pos.sell`, `pos.discount`, `inventory.read`, `credit.read`, `customers.read`, `web_orders.read/fulfill`; default approval policy rows for `pos.refund`, `pos.void`, `credit.adjust`, `pos.price_override` (mode=approval) |

Escalation rules (enforced server-side, tested): a grantor can only assign a role
whose perms ⊆ their own; only owners grant owner; nobody edits their own
membership; the last active owner can't be disabled or demoted.

## Endpoints
- `GET /v1/me` → user + `stores[]` (from `my_stores`), no tenant selector needed.
- `POST /v1/stores` → onboarding (`create_store`).
- `GET/POST /v1/staff`, `PATCH /v1/staff/{user_id}` (role, status), `DELETE`
  = disable — `staff.manage`.
- `POST /v1/invites` (`staff.manage`), `GET /v1/invites`, `DELETE
  /v1/invites/{id}`; `POST /v1/invites/accept {token}` (authenticated, no
  selector; verified token email must equal invite email — Cognito access
  tokens carry no email, so the server reads `email` from `app_user`, which is
  set from the ID token / userinfo at first login; dev issuer puts it in the
  token). Invite email delivery: log the link locally (no SES yet).
- `GET /v1/roles` (list with perms).
- `PUT /v1/me/pin {pin}` (signed-in staff set their own PIN; 6 digits, reject
  trivial: repeated, sequential).
- `POST /v1/registers/{id}/enroll` (`registers.manage`) → device secret once;
  `GET /v1/registers/devices`, `DELETE /v1/registers/devices/{id}` (revokes all
  its sessions).
- `GET /v1/register/staff` (device auth) → names + user ids who can sign in.
- `POST /v1/register/sessions {user_id, pin}` (device auth) → opaque session
  token (12 h absolute, 30 min idle). `DELETE` = lock/sign out.
- Register requests: `Authorization: Device <device_secret>` +
  `X-Register-Session: <token>`; actor `device:<id>/user:<id>`.
- Approvals: a route that needs approval returns 403
  `{"detail": {"approval_required": "<perm>", "amount_cents": n}}`. Client calls
  `POST /v1/approvals {perm, payload_hash, amount_cents, approver_user_id, pin}`
  (device auth) → `{approval_id, expires_at}` (60 s, single use), then retries
  with `X-Approval: <id>`. Server recomputes the payload hash, atomically
  consumes, checks the approver holds the perm + `approve.override`, sets
  `app.approved_by`.
- API keys: `POST/GET/DELETE /v1/api-keys` (`apikeys.manage`).

PIN rules: Argon2id (argon2-cffi), 5 failures → lockout 1 min doubling to 1 h,
per-device rate limit via `ratelimit.py`, failed attempts audited, PIN valid
only with an enrolled, unrevoked device.

## Frontend (`apps/tcg-pos`)
- Back office: Cognito hosted UI + PKCE, adapted from
  `apps/choices-webapp/frontend/src/lib/auth.js`; in local dev a "Dev login"
  form calls `/v1/dev/login`. Store switcher from `/v1/me`. Team page (staff
  list, invite, role change, disable). Every request sends bearer + selector.
- Register mode: enroll screen (manager signs in once), staff picker + PIN pad,
  idle auto-lock, approval modal (manager picks name + PIN) that retries the
  original request.
- Storefront app is untouched.

## Cognito (template.yaml, not deployed)
New `UserPool` (email sign-in, self-signup, email verification, Lite tier,
optional Google IdP param), SPA `UserPoolClient` (PKCE, no secret, code flow,
callback URLs param), `UserPoolDomain`. Function env: `AUTH_ISSUER`,
`AUTH_CLIENT_IDS`. Remove the "no auth yet — do not deploy" warning only when
this lands. OPS.md: pool setup, SES for invite mail (Cognito default sender is
capped ~50/day), Google account-linking note (key on `sub`, never auto-merge).

## Tests
- Token: alg none, HS256-with-public-key, wrong iss / client_id, id token as
  access token, expired, unknown kid, missing sub.
- Coverage: every non-public route has a `require`.
- Permission matrix: role × endpoint from `tests/fixtures/perm_matrix.yaml`.
- RLS/tenancy: member of A selecting B → 403; raw SQL with A's GUCs sees no B;
  forged actor rejected by trigger.
- Flows: invite (email mismatch, reuse, expiry), escalation (manager → owner,
  self-edit, last owner), PIN lockout, revoked device, session idle expiry,
  approval replay / payload swap / expiry / approver lacking perm.
- Existing tests move from `X-Actor` to minted tokens via a conftest helper.

## Milestones
- **A1** 0011 + tokens + principal + `require` on every route + actor trigger +
  dev issuer + `/v1/me` + onboarding + test migration of the existing suite.
- **A2** invites, staff, roles endpoints + escalation rules.
- **A3** 0012 register devices, PIN sessions, approvals + policies.
- **A4** 0013 API keys; Cognito resources in template.yaml; OPS.md / README.
- **A5** `apps/tcg-pos` login, store switcher, team page, register mode, approval modal.

## Implementation notes (A1 + A2, 2026-10-14)
Built as planned except where noted; each deviation says why.

- **Route → permission map** (the plan left it open; `tests/fixtures/perm_matrix.yaml`
  is the source of truth): inventory list, `GET /pricing/rule` and
  `/pricing/suggest` → `inventory.read`; adjust → `inventory.adjust`; price
  PATCH → `inventory.price_edit`; TCGplayer import (dry run too) →
  `imports.run`; `PUT /pricing/rule` → `pricing.rules_manage`; credit balance →
  `credit.read`, issue → `credit.issue`, **redeem → `pos.sell`** (redeeming is
  spending credit as tender at the counter; a cashier must be able to take it.
  A downward correction without a sale will be `credit.adjust`); storefront
  settings GET and PUT → `storefront.manage`; web orders list →
  `web_orders.read`, picked-up / cancel → `web_orders.fulfill`; staff, invites
  and `GET /v1/roles` → `staff.manage`.
- **`accept_invite(sub, token_hash)`** — no `email` parameter: the function
  compares the invite to `app_user.email` itself, so a caller can't pass a
  different address. `ensure_app_user(sub, email)` stores the email from the
  verified token first (dev tokens carry it; for Cognito, see A4 below).
- **Extra columns:** `invite.revoked_at` + `invite.accepted_by` (revoking is an
  UPDATE because the app role has no DELETE anywhere), `membership.updated_at`.
- **`tenant_staff()`** definer function: the staff list needs names/emails from
  `app_user`, which the app role can't read.
- **No `POST /v1/staff`.** Invites are the only way in (adding a user by id
  without their consent isn't wanted); A2 is `GET /v1/staff`, `PATCH`,
  `DELETE` (= disable).
- **Escalation, one extra rule:** you may only change, disable, or revoke an
  invite for a role you could grant yourself (so a manager can't touch an
  owner). Staff changes in a store are serialized by an advisory lock; a
  trigger (`membership_last_owner`) refuses to leave a store without an active
  owner as the backstop. Through HTTP the last-owner path is only reachable in
  a race (self-edit is refused and only owners act on owners); it is tested
  directly and via the trigger.
- **Actor columns** also cover `buylist.created_by`. The trigger checks
  `approved_by` against `app.approved_by` the same way it checks `actor`.
  Storefront orders now record `storefront:<slug>` (was `web:<email>`; the
  email stays on the order row); the expiry job records
  `job:expire_reservations` (was `system:…`); `scripts/backfill_owner.py`
  writes `job:backfill_owner`.
- **Missing `X-Tenant-Id` with a valid token → 400** (it's a selector, not a
  credential). Missing/invalid token → 401 with `WWW-Authenticate: Bearer`;
  JWKS unreachable → 503.
- **Dev issuer:** `iss = urn:tcg-pos:dev-issuer`, `client_id = tcg-pos-dev`,
  `sub = uuid5(email)` so an address is the same user across restarts, `kid` =
  RFC 7638 thumbprint. PyJWT 2.14 refuses non-http(s) JWKS URLs, so a small
  `FileJWKClient` reads `file://` JWKS (dev issuer and tests only — the URL is
  config, never token input). Remote JWKS keep PyJWT's 30 s refetch cooldown
  on an unknown `kid`. `scripts/serve-local.py` defaults to `ENV=local` + the
  dev issuer.
- **Approval-policy default rows** for cashier wait for 0012 (the table arrives
  there).
- `GET /v1/me`/`POST /v1/stores`/`POST /v1/invites/accept` are the three
  signed-in-but-storeless routes; `tests/test_route_coverage.py` holds that list.

Open for A3+: where Cognito users' email comes from (access tokens have none —
pre-token-generation trigger adding `email`, or the SPA posting the ID token
to an `/v1/me/profile`-style endpoint); `create_store` has no rate limit or
cap per user; custom roles (`roles.manage`) must forbid system keys; the
`apps/tcg-pos` frontend still sends `X-Actor` and has no login (A5), so it
can't call staff routes until then.
