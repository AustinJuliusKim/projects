// Same-origin /api by default (the vite dev server proxies /api →
// localhost:8000); VITE_API_BASE overrides, e.g. a direct execute-api URL.
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

// TODO(auth): the tenant id is sent as a plain header until the API reads it
// from a verified auth token instead.
async function getJSON(path, params, { tenantId, signal } = {}) {
  const resp = await fetch(`${API_BASE}${path}${buildQuery(params)}`, {
    signal,
    headers: tenantId ? { "X-Tenant-Id": tenantId } : {},
  });
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(
      typeof detail.detail === "string" ? detail.detail : `API error ${resp.status}`,
    );
  }
  return resp.json();
}

export const listInventory = (params, opts) => getJSON("/v1/inventory", params, opts);

export const isAbortError = (e) => e && e.name === "AbortError";
