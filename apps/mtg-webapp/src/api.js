// Same-origin /api in prod (CloudFront /api/* behavior → the mtg-api
// HttpApi; Mangum strips the prefix). VITE_API_BASE overrides for direct
// execute-api access; the vite dev server proxies /api → localhost:8000.
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

// `signal` (an AbortController's signal) lets callers cancel in-flight
// requests — needed now that search fires while typing, so a fast typist
// doesn't race stale responses against fresh ones. A caller-initiated
// abort throws a DOMException named "AbortError"; callers should treat
// that as "ignore, a newer request superseded this one," not a real error.
async function getJSON(path, params, { signal } = {}) {
  const resp = await fetch(`${API_BASE}${path}${buildQuery(params)}`, { signal });
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(detail.detail || `API error ${resp.status}`);
  }
  return resp.json();
}

export const searchCards = (params, opts) => getJSON("/v1/cards/search", params, opts);
export const autocomplete = (q, opts) => getJSON("/v1/cards/autocomplete", { q }, opts);
export const namedExact = (name, opts) => getJSON("/v1/cards/named", { exact: name }, opts);
export const getCard = (oracleId, opts) => getJSON(`/v1/cards/${oracleId}`, undefined, opts);
export const getSimilar = (oracleId, params, opts) =>
  getJSON(`/v1/cards/${oracleId}/similar`, params, opts);
export const getPrintings = (oracleId, opts) =>
  getJSON(`/v1/cards/${oracleId}/printings`, undefined, opts);
export const getRulings = (oracleId, opts) =>
  getJSON(`/v1/cards/${oracleId}/rulings`, undefined, opts);
export const randomCard = (opts) => getJSON("/v1/cards/random", undefined, opts);

// True for the error fetch() throws when a request is aborted via
// AbortController — callers should swallow this, not surface it as a
// user-facing failure.
export const isAbortError = (e) => e && e.name === "AbortError";
