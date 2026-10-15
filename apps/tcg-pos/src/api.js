// The one place requests to the POS API are built. It attaches the caller's
// credential (a bearer token + X-Tenant-Id in the back office, or the
// register's Device secret + X-Register-Session), X-Approval on an approved
// retry, and maps auth failures to app state (sign in / enroll / PIN pad)
// through the provider App installs with configureApi().
//
// Same-origin /api by default (the vite dev server proxies /api →
// localhost:8001); VITE_API_BASE overrides, e.g. a direct execute-api URL.
const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
export const API_BASE = env.VITE_API_BASE || "/api";

// Query-string builder, exported for tests: drops null/undefined/empty.
export function buildQuery(params = {}) {
  const pairs = Object.entries(params).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  if (pairs.length === 0) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of pairs) qs.set(k, v);
  return `?${qs.toString()}`;
}

// --- credentials and headers ------------------------------------------------------

// auth is one of
//   { kind: "bearer", token, tenantId? }           signed-in back office
//   { kind: "device", secret, sessionToken? }      an enrolled register
//   null                                           no credential (dev login)
// The device decides the store in register mode, so no X-Tenant-Id there.
// `tenant: false` drops X-Tenant-Id for the tenant-less routes (/v1/me,
// /v1/stores, /v1/invites/accept).
export function buildHeaders(auth, { approvalId, tenant = true } = {}) {
  const h = {};
  if (auth && auth.kind === "bearer" && auth.token) {
    h.Authorization = `Bearer ${auth.token}`;
    if (tenant && auth.tenantId) h["X-Tenant-Id"] = auth.tenantId;
  } else if (auth && auth.kind === "device" && auth.secret) {
    h.Authorization = `Device ${auth.secret}`;
    if (auth.sessionToken) h["X-Register-Session"] = auth.sessionToken;
  }
  if (approvalId) h["X-Approval"] = approvalId;
  return h;
}

// --- errors -----------------------------------------------------------------------

const REASON_TEXT = {
  invalid_id_token: "Your sign-in couldn't be verified; sign in again.",
  store_limit: "You already own the maximum number of stores.",
  sign_in_required: "Do this from the back office while signed in, not on a register.",
  register_session_required: "This only works on an enrolled register with someone signed in.",
  self_approval: "You can't approve your own request: another manager must enter their PIN.",
  approver_not_allowed: "That person isn't allowed to approve this.",
  device_unknown: "This register isn't enrolled (or was revoked).",
  session_required: "Sign in on the register first.",
  session_invalid: "The register session isn't valid; sign in again.",
  session_ended: "The register was locked; sign in again.",
  session_expired: "The register session expired; sign in again.",
  session_idle: "The register locked after being idle; sign in again.",
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A readable message for an object `detail` (the auth routes' {reason, ...}).
function detailText(status, detail, retryAfter) {
  if (detail.approval_required) {
    return detail.approval_error
      ? "That approval was invalid, expired or already used. Ask a manager to approve again."
      : `A manager's approval is needed (${detail.approval_required}).`;
  }
  if (typeof detail.missing === "string") {
    if (detail.reason === "back_office_only") {
      return `That's a back-office task (${detail.missing}): sign in to the back office with your own account.`;
    }
    return `You don't have permission to do that (${detail.missing}).`;
  }
  const { reason } = detail;
  if (reason === "wrong_pin") {
    return typeof detail.attempts_left === "number"
      ? `Wrong PIN. ${plural(detail.attempts_left, "attempt")} left before it locks.`
      : "Wrong PIN.";
  }
  if (reason === "pin_locked") {
    const s = detail.retry_after ?? retryAfter;
    return `Too many wrong PINs: locked${s ? ` for ${plural(s, "second")}` : ""}.`;
  }
  if (reason === "store_limit" && detail.limit) {
    return `You already own the maximum of ${detail.limit} stores.`;
  }
  if (reason === "approver_not_allowed" && detail.perm) {
    return `That person isn't allowed to approve this (needs ${detail.perm} and approve.override).`;
  }
  let text = REASON_TEXT[reason] || detail.message || reason;
  // Escalation 403s and API-key 422s: {reason: "<sentence>", missing|perms: [...]}.
  const list = Array.isArray(detail.missing) ? detail.missing : detail.perms;
  if (text && Array.isArray(list) && list.length) text = `${text}: ${list.join(", ")}`;
  return text || `API error ${status}`;
}

// Error message from a FastAPI error body: a string `detail`, the first
// validation error's message for a 422, or an auth route's {reason, ...}.
export function errorMessage(status, body, { retryAfter } = {}) {
  const detail = body && body.detail;
  if (typeof detail === "string") {
    if (status === 429 && retryAfter) return `Too many attempts; try again in ${plural(retryAfter, "second")}.`;
    return detail;
  }
  if (Array.isArray(detail) && detail.length > 0 && detail[0].msg) {
    const loc = Array.isArray(detail[0].loc) ? detail[0].loc.slice(1).join(".") : "";
    return loc ? `${loc}: ${detail[0].msg}` : detail[0].msg;
  }
  if (detail && typeof detail === "object") return detailText(status, detail, retryAfter);
  if (status === 429) return "Too many attempts; try again shortly.";
  return `API error ${status}`;
}

// What the app should do about a failed response:
//   sign_in      back-office token missing/expired/invalid → signed-out screen
//   enroll       register device unknown or revoked (device_unknown) → enroll again
//   pin          register session gone → lock screen (PIN pad)
//   approval     needs a manager's approval → approval modal
//   pin_locked | rate_limited | forbidden | error
export function classifyError(status, detail, { scheme } = {}) {
  const d = detail && typeof detail === "object" ? detail : {};
  if (status === 401) {
    if (d.reason === "device_unknown") return "enroll";
    if (typeof d.reason === "string" && d.reason.startsWith("session_")) return "pin";
    // A device credential on a bearer-only route: not the device's fault,
    // so don't forget the enrollment over it.
    if (scheme === "device") return "error";
    return "sign_in";
  }
  if (status === 403 && d.approval_required) return "approval";
  if (status === 423) return "pin_locked";
  if (status === 429) return "rate_limited";
  if (status === 403) return "forbidden";
  return "error";
}

export class ApiError extends Error {
  constructor(status, body, { retryAfter = null, scheme = null } = {}) {
    super(errorMessage(status, body, { retryAfter }));
    this.name = "ApiError";
    this.status = status;
    this.detail = body ? body.detail : undefined;
    this.retryAfter = retryAfter;
    this.kind = classifyError(status, this.detail, { scheme });
    const d = this.detail && typeof this.detail === "object" ? this.detail : {};
    this.reason = d.reason || null;
  }
}

// --- the request ------------------------------------------------------------------

let provider = { getAuth: async () => null, onAuthFailure: () => {} };

// App installs where credentials come from and who hears about auth
// failures. getAuth may be async (it refreshes an expiring token).
export function configureApi(next) {
  provider = { ...provider, ...next };
}

function retryAfterSeconds(resp) {
  const v = resp.headers && resp.headers.get && resp.headers.get("Retry-After");
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function request(
  method,
  path,
  {
    params,
    json,
    text,
    contentType,
    signal,
    base = API_BASE,
    auth,
    tenant = true,
    approvalId,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  // An explicit `auth` (even null) is used as-is and its 401s aren't
  // reported: the caller is mid-sign-in and handles them itself.
  const explicit = auth !== undefined;
  const credential = explicit ? auth : await provider.getAuth();
  const headers = buildHeaders(credential, { approvalId, tenant });
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (text !== undefined) {
    headers["Content-Type"] = contentType || "text/plain";
    body = text;
  }
  const resp = await fetchImpl(`${base}${path}${buildQuery(params)}`, {
    method,
    signal,
    headers,
    body,
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new ApiError(resp.status, payload, {
      retryAfter: retryAfterSeconds(resp),
      scheme: credential ? credential.kind : null,
    });
    if (!explicit && ["sign_in", "enroll", "pin"].includes(err.kind)) {
      provider.onAuthFailure({ kind: err.kind, reason: err.reason, message: err.message });
    }
    throw err;
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export const isAbortError = (e) => e && e.name === "AbortError";

// --- endpoints --------------------------------------------------------------------

// inventory / pricing / import (existing pages)
export const listInventory = (params, opts) =>
  request("GET", "/v1/inventory", { ...opts, params });

export const adjustInventory = (body, opts) =>
  request("POST", "/v1/inventory/adjust", { ...opts, json: body });

export const suggestPrice = (params, opts) =>
  request("GET", "/v1/pricing/suggest", { ...opts, params });

export const importTcgplayer = (csvText, { locationId, dryRun }, opts) =>
  request("POST", "/v1/inventory/import/tcgplayer", {
    ...opts,
    params: { location_id: locationId, dry_run: dryRun ? "true" : "false" },
    text: csvText,
    contentType: "text/csv",
  });

// account (bearer, no store selected)
export const devLogin = (email, name) =>
  request("POST", "/v1/dev/login", { auth: null, json: name ? { email, name } : { email } });

export const syncIdentity = (accessToken, idToken) =>
  request("POST", "/v1/me/identity", {
    auth: { kind: "bearer", token: accessToken },
    json: { id_token: idToken },
  });

export const getMe = (opts) => request("GET", "/v1/me", { ...opts, tenant: false });

export const createStore = (body, opts) =>
  request("POST", "/v1/stores", { ...opts, tenant: false, json: body });

export const acceptInvite = (token, opts) =>
  request("POST", "/v1/invites/accept", { ...opts, tenant: false, json: { token } });

export const setMyPin = (pin, opts) => request("PUT", "/v1/me/pin", { ...opts, json: { pin } });

// team (staff.manage)
export const listRoles = (opts) => request("GET", "/v1/roles", opts);
export const listStaff = (opts) => request("GET", "/v1/staff", opts);
export const updateStaff = (userId, body, opts) =>
  request("PATCH", `/v1/staff/${userId}`, { ...opts, json: body });
export const disableStaff = (userId, opts) => request("DELETE", `/v1/staff/${userId}`, opts);
export const listInvites = (opts) => request("GET", "/v1/invites", opts);
export const createInvite = (body, opts) =>
  request("POST", "/v1/invites", { ...opts, json: body });
export const revokeInvite = (id, opts) => request("DELETE", `/v1/invites/${id}`, opts);

// registers (registers.manage)
export const listRegisters = (opts) => request("GET", "/v1/registers", opts);
export const createRegister = (body, opts) =>
  request("POST", "/v1/registers", { ...opts, json: body });
export const enrollDevice = (registerId, opts) =>
  request("POST", `/v1/registers/${registerId}/enroll`, opts);
export const listDevices = (opts) => request("GET", "/v1/registers/devices", opts);
export const revokeDevice = (id, opts) => request("DELETE", `/v1/registers/devices/${id}`, opts);

// on the register (Device credential)
export const registerStaff = (opts) => request("GET", "/v1/register/staff", opts);
export const registerSignIn = (userId, pin, opts) =>
  request("POST", "/v1/register/sessions", { ...opts, json: { user_id: userId, pin } });
export const registerSignOut = (opts) => request("DELETE", "/v1/register/sessions", opts);
export const createApproval = (body, opts) =>
  request("POST", "/v1/approvals", { ...opts, json: body });

// store credit
export const getCredit = (customerId, opts) =>
  request("GET", `/v1/customers/${customerId}/credit`, opts);
export const adjustCredit = (customerId, body, opts) =>
  request("POST", `/v1/customers/${customerId}/credit/adjust`, { ...opts, json: body });

// API keys (apikeys.manage)
export const listApiKeys = (opts) => request("GET", "/v1/api-keys", opts);
export const createApiKey = (body, opts) =>
  request("POST", "/v1/api-keys", { ...opts, json: body });
export const revokeApiKey = (id, opts) => request("DELETE", `/v1/api-keys/${id}`, opts);
