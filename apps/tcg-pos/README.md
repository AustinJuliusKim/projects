# tcg-pos

Counter/back-office frontend for the TCG card-shop POS
(`services/tcg-pos-api`). Vite + React 19 + Mantine, same conventions as
`apps/mtg-webapp`. The API contract it codes against is
[`AUTH_CONTRACT.md`](AUTH_CONTRACT.md) (the API code wins if they differ).

## Two ways in

- **Back office** — a person signs in with their own account: Cognito
  hosted UI (authorization code + PKCE) in real builds, or a **dev login**
  form (`POST /v1/dev/login`) in dev builds. Then `POST /v1/me/identity`,
  a store switcher from `/v1/me` (last store remembered), and create-store
  for a user with none. Requests send `Authorization: Bearer` +
  `X-Tenant-Id`.
- **Register mode** — a browser enrolled as a register (Registers page →
  "Enroll this device"; the device secret lives in localStorage). Staff
  pick their name and enter their 6-digit PIN; the session token lives in
  sessionStorage. Lock button, idle auto-lock at the server's idle timeout
  (30 min), and the pages run under the session user's permissions.
  Requests send `Authorization: Device` + `X-Register-Session`.

`src/api.js` is the only place headers are built, and it maps 401s to app
state: bearer → signed out, `device_unknown` → enroll again, `session_*` →
PIN pad.

Pages (hidden when your role lacks the permission; the API still checks):

- **Inventory / Receive / Import** — stock, as before. The location ID is
  typed in (remembered per store); in register mode it's the register's.
- **Store credit** — look a customer up by ID, adjust ± with a reason.
  Cashiers need a manager's approval: the API answers `approval_required`,
  a modal takes the manager's name + PIN (`POST /v1/approvals`) and the
  identical request is retried with `X-Approval`. Register mode only.
- **Team** — staff, roles, invites (create, revoke), disable/enable.
- **Registers** — create, enroll this device, list/revoke devices.
- **API keys** — owners: create (key shown once), list, revoke.
- **My PIN** — set your register PIN for the selected store.
- `/invite?token=…` — accept an invite after signing in.

Pure logic lives in `src/*.js` and is tested with `node --test` (PKCE,
token/session handling, the auth reducer, header building and error
mapping, the approval retry, the idle timer, permission gating, forms);
the `.jsx` components stay thin.

## Develop

```bash
npm ci
npm test        # node --test over the pure modules
npm run dev     # http://localhost:5173, proxies /api → localhost:8001
```

Run both backends locally first:

- `services/mtg-api` on :8000 (catalog + prices; its CORS is open).
- `services/tcg-pos-api` on :8001: `make serve-dev` (the seeded demo store:
  `owner@demo.test` PIN 284716, `cashier@demo.test` PIN 461938). Invite
  accept links are printed in its log (no invite email yet).

| Env | Default | |
| --- | --- | --- |
| `VITE_API_BASE` | `/api` | POS API base (dev server proxies `/api` → :8001) |
| `VITE_MTG_API_BASE` | `http://localhost:8000` | mtg-api base for card search/printings |
| `VITE_COGNITO_DOMAIN` | — | Hosted UI base (stack output `HostedUiDomain`) |
| `VITE_COGNITO_CLIENT_ID` | — | SPA app client (stack output `UserPoolClientId`) |
| `VITE_COGNITO_REDIRECT_PATH` | `/auth/callback` | Must match one of `AppCallbackUrls` |
| `VITE_AUTH_MODE` | — | `dev` forces dev login (dev builds only) |

Without Cognito env a dev build uses dev login; a **production** build
without it (or with `VITE_AUTH_MODE=dev`) shows a configuration error
instead of starting, and `npm run build` warns.

## Known gaps (API side)

- `/v1/me` gives each store's role but not its permissions, and
  `GET /v1/roles` needs `staff.manage`; the back office mirrors the system
  roles' permissions from `migrations/0011_rbac.sql`, and shows every page
  for a store-defined role it can't read.
- No locations list and no customer search endpoint: location and customer
  IDs are typed in.
- Invites aren't emailed and the link isn't returned; locally it's logged.
