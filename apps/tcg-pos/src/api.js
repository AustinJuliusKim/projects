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

// Error message from a FastAPI error body: a string `detail`, or the first
// validation error's message for a 422. Exported for tests.
export function errorMessage(status, body) {
  const detail = body && body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length > 0 && detail[0].msg) {
    const loc = Array.isArray(detail[0].loc) ? detail[0].loc.slice(1).join(".") : "";
    return loc ? `${loc}: ${detail[0].msg}` : detail[0].msg;
  }
  return `API error ${status}`;
}

// TODO(auth): tenant and actor are sent as plain headers until the API reads
// them from a verified auth token instead.
export function authHeaders({ tenantId, actor } = {}) {
  const h = {};
  if (tenantId) h["X-Tenant-Id"] = tenantId;
  if (actor) h["X-Actor"] = actor;
  return h;
}

export async function request(
  method,
  path,
  { params, json, text, contentType, tenantId, actor, signal, base = API_BASE } = {},
) {
  const headers = authHeaders({ tenantId, actor });
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (text !== undefined) {
    headers["Content-Type"] = contentType || "text/plain";
    body = text;
  }
  const resp = await fetch(`${base}${path}${buildQuery(params)}`, {
    method,
    signal,
    headers,
    body,
  });
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(errorMessage(resp.status, detail));
  }
  return resp.json();
}

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

export const isAbortError = (e) => e && e.name === "AbortError";
