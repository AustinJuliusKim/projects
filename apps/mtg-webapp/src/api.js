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

async function getJSON(path, params) {
  const resp = await fetch(`${API_BASE}${path}${buildQuery(params)}`);
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(detail.detail || `API error ${resp.status}`);
  }
  return resp.json();
}

export const searchCards = (params) => getJSON("/v1/cards/search", params);
export const autocomplete = (q) => getJSON("/v1/cards/autocomplete", { q });
export const namedExact = (name) => getJSON("/v1/cards/named", { exact: name });
export const getCard = (oracleId) => getJSON(`/v1/cards/${oracleId}`);
export const getSimilar = (oracleId, params) =>
  getJSON(`/v1/cards/${oracleId}/similar`, params);
export const getPrintings = (oracleId) => getJSON(`/v1/cards/${oracleId}/printings`);
export const getRulings = (oracleId) => getJSON(`/v1/cards/${oracleId}/rulings`);
export const randomCard = () => getJSON("/v1/cards/random");
