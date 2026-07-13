/**
 * Fetch wrappers for the accounts/progress API. EVERY call is offline-
 * tolerant: failures (no backend, network down, non-2xx) resolve to null and
 * are never thrown — guided mode must work with no backend at all (the e2e
 * suite runs exactly that way). Cookies ride along via credentials:include
 * (the gr_session cookie is httpOnly and first-party behind /api/*).
 */

const BASE = "/api";

/**
 * @param {string} path
 * @param {{method?: string, body?: object}} [opts]
 * @returns {Promise<object|null>} parsed JSON, or null on any failure
 */
async function request(path, { method = "GET", body } = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** @param {{anonId: string, name?: string, email?: string, consent: boolean, source: string}} lead */
export function postLead(lead) {
  return request("/leads", { method: "POST", body: lead });
}

/** @param {string} lessonId @param {{status: string, assertions?: object, anonId?: string}} body */
export function putProgress(lessonId, body) {
  return request(`/progress/${encodeURIComponent(lessonId)}`, { method: "PUT", body });
}

/** @param {{anonId?: string}} [opts] */
export function getProgress({ anonId } = {}) {
  const qs = anonId ? `?anonId=${encodeURIComponent(anonId)}` : "";
  return request(`/progress${qs}`);
}

/**
 * Proof-gate event. Falls back to sendBeacon (fire-and-forget, survives
 * navigation) when fetch fails.
 *
 * @param {string} kind
 * @param {object} [payload]
 * @param {string|null} [anonId]
 */
export async function postEvent(kind, payload = {}, anonId = null) {
  const body = { events: [{ kind, payload }], ...(anonId ? { anonId } : {}) };
  const result = await request("/events", { method: "POST", body });
  if (result === null) {
    try {
      navigator.sendBeacon?.(
        `${BASE}/events`,
        new Blob([JSON.stringify(body)], { type: "application/json" }),
      );
    } catch {
      // Offline: events are best-effort by design.
    }
  }
  return result;
}

/** @param {string} email @param {string|null} [anonId] */
export function requestMagicLink(email, anonId = null) {
  return request("/auth/magic-link", { method: "POST", body: { email, ...(anonId ? { anonId } : {}) } });
}

/** @param {{tokenHash: string, type?: string, anonId?: string|null}} params */
export function verifyMagicLink({ tokenHash, type = "magiclink", anonId = null }) {
  return request("/auth/verify", {
    method: "POST",
    body: { tokenHash, type, ...(anonId ? { anonId } : {}) },
  });
}

export function getMe() {
  return request("/me");
}

export function getAccount() {
  return request("/account");
}

/** @param {{name?: string, marketingConsent?: boolean}} fields */
export function patchAccount(fields) {
  return request("/account", { method: "PATCH", body: fields });
}

export function deleteAccount() {
  return request("/account", { method: "DELETE" });
}

export function logout() {
  return request("/auth/logout", { method: "POST", body: {} });
}
