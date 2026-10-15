# tcg-pos-api auth contract for apps/tcg-pos (A5)

Source of truth is the API code (`services/tcg-pos-api/src/tcg_pos_api/auth/`, `routes/{account,staff,registers,api_keys,credit,dev}.py`) and `services/tcg-pos-api/docs/AUTH_PLAN.md`. This file summarises it for the frontend; if they disagree, the code wins.

## Back-office login
- Production: Cognito hosted UI, authorization code + PKCE S256 (adapt `apps/choices-webapp/frontend/src/lib/auth.js`). Env: `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`; scopes `openid email profile`.
- Local: `POST /v1/dev/login {email, name?}` → `{access_token, id_token, token_type: "Bearer", expires_in, sub}` (only exists when the API uses the dev issuer).
- After either: `POST /v1/me/identity {"id_token": ...}` with `Authorization: Bearer <access>` → `{user: {id, email, display_name}, stores: [{tenant_id, name, role, role_name}]}`; bad token → 422 `{detail: {reason: "invalid_id_token", message}}`.
- Store calls: `Authorization: Bearer <access>` + `X-Tenant-Id: <tenant_id>`. `GET /v1/me` feeds the store switcher. `POST /v1/stores {name, location_name?}` → 201 `{tenant_id, name, role, role_name}` | 403 `{reason: "store_limit", limit}` | 429 + Retry-After.
- Errors: missing perm 403 `{detail: {missing: "<perm>"}}` (plus `reason: "back_office_only"` when the perm exists but is never held over a register session or API key — see Register mode); not a member 403 `"you are not a member of that store"`; bad/missing bearer 401 + `WWW-Authenticate: Bearer`.
- Email: only the verified ID token sets it (`/v1/me/identity`); an access token's `email` claim is ignored except from the local dev issuer.
- Stop sending `X-Actor` (ignored now).

## Team (staff.manage)
`GET /v1/staff`, `PATCH /v1/staff/{user_id}` (role / status), `DELETE /v1/staff/{user_id}` (disable), `POST /v1/invites {email, role}`, `GET /v1/invites`, `DELETE /v1/invites/{id}`, `GET /v1/roles`. `POST /v1/invites/accept {token}` (bearer, no X-Tenant-Id). Read the route modules for exact shapes and error reasons (escalation errors are 403s).
- A status or role change ends that member's open register sessions. Accepting an invite answers 410 "no longer valid" if whoever sent it has since been disabled or demoted below the invite's role (it works again if their access is restored).

## Own PIN
`PUT /v1/me/pin {pin}` (bearer + X-Tenant-Id) → 204; trivial/malformed → 422 (string detail); over a register session → 403 `{reason: "sign_in_required"}`. 6 digits. Setting a PIN clears every lockout on it and ends the caller's open register sessions in that store.

## Register admin (registers.manage)
- `GET /v1/registers` → `[{id, location_id, name, created_at}]`; `POST /v1/registers {location_id, name}` → 201 same shape.
- `POST /v1/registers/{id}/enroll` → 201 `{device: {...}, device_secret: "tcgdev_…"}` — secret shown once; store in localStorage on that device.
- Enrolling hands the browser to the register: the app ends the enrolling person's back-office session there (clear it, revoke the Cognito refresh token via `/oauth2/revoke`, hosted-UI logout). An enrolled browser keeps a back-office session in memory only (no refresh token, never in storage), and every switch between register mode and the back office ends it, so the back office always needs a fresh sign-in (`prompt=login`).
- `GET /v1/registers/devices`; `DELETE /v1/registers/devices/{id}` → revoked device (409 if already revoked).

## Register mode (shared device)
- Every request: `Authorization: Device <secret>` (no X-Tenant-Id needed).
- `GET /v1/register/staff` → `[{user_id, name, role}]` (members with a PIN).
- `POST /v1/register/sessions {user_id, pin}` → 201 `{session_id, session_token: "tcgreg_…", user_id, name, role, perms[], expires_at, idle_timeout_seconds: 1800}`. Failures: 403 `{detail: {reason: "wrong_pin", attempts_left?}}`; 423 `{detail: {reason: "pin_locked", retry_after, scope: "device"|"store"}}` + Retry-After; 429 + Retry-After.
- Lockout is per (person, device): the 5th straight wrong PIN on a register locks that PIN on that register only (1 min, doubling to 1 h; `scope: "device"`). Past 11 straight failures from two or more registers, each failure locks it on every register for an hour (`scope: "store"`). A correct PIN resets that register's count and the store-wide one. `attempts_left` counts down to whichever lock is nearer. Locks are audited (`pin.lock`).
- Then also send `X-Register-Session: <session_token>`; store routes work with the session user's perms **minus the back-office-only perms**: `staff.manage`, `roles.manage`, `registers.manage`, `apikeys.manage`, `billing.manage`, `settings.manage`, `channels.manage`, `storefront.manage`, `pricing.rules_manage` (403 `{missing, reason: "back_office_only"}`; the sign-in `perms[]` already omit them). An owner's PIN on a register can't mint keys, enroll devices or manage staff.
- `DELETE /v1/register/sessions` → 204 (lock / sign out).
- Device 401s: `{detail: {reason, message}}` + `WWW-Authenticate: Device`. `device_unknown` → enroll screen; `session_required|session_invalid|session_ended|session_expired|session_idle` → PIN pad.
- Client-side idle auto-lock at 30 min (server enforces too).

## Approvals
1. Gated request → 403 `{detail: {approval_required: "<perm>", amount_cents, payload_hash, summary}}` (plus `approval_error: "invalid"` when a supplied approval was bad/used/expired/mismatched). `summary` is built by the server: `{title, lines[]}` plus route fields — credit adjust: `{title: "Remove $25.00 store credit", lines: ["Customer: Pat", "Change: -$25.00 (take from their balance)", "Reason: fix", "Balance: $50.00 -> $25.00"], customer_name, delta_cents (signed), reason, balance_cents}`. Show it (direction first) before the PIN pad; `amount_cents` stays unsigned.
2. Manager picks name (from `/v1/register/staff`) + PIN → `POST /v1/approvals {perm, payload_hash, amount_cents, approver_user_id, pin}` with the cashier's device + session headers → 201 `{approval_id, perm, amount_cents, approved_by, expires_at}`. Failures: 422 for a malformed body (checked before the PIN; `amount_cents` ≤ 2^31−1), 403 `{reason: "self_approval"}`, 403 `{reason: "approver_not_allowed", perm}`, wrong_pin / pin_locked / 429 as above.
3. Retry the identical request (same method, path, body) with `X-Approval: <approval_id>` within 60 s; single use.
- Approvals only work in register mode (both requester session and approver PIN on an enrolled device).
- Only gated route today: `POST /v1/customers/{id}/credit/adjust {delta_cents (≠0, signed), reason}` → `{customer_id, balance_cents}` | 404 unknown customer (before any approval) | 409 if balance would go negative.

## API keys (apikeys.manage, owners)
`POST /v1/api-keys {name, perms[]}` → 201 `{id, name, prefix, perms, status, created_by, created_at, last_used_at, revoked_at, key}` (key shown once); 422 forbidden/unknown perm (forbidden = the back-office-only perms above plus `approve.override`); 403 `{reason, missing[]}` for perms the creator lacks. `GET /v1/api-keys`; `DELETE /v1/api-keys/{id}` (409 if revoked).

## Local dev data (tcg_pos_dev)
Demo store owner `owner@demo.test` (PIN 284716), cashier `cashier@demo.test` (PIN 461938). API: `make serve-dev` in services/tcg-pos-api (:8001).
