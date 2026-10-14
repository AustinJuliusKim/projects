// Public storefront API client: /v1/storefront/{slug}/... on tcg-pos-api.
// Same-origin /api by default (the vite dev server proxies /api →
// localhost:8001 and strips the prefix); VITE_API_BASE overrides.
// Everything that shapes a request or reads an error is pure and exported
// for tests; only request() touches the network.

const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
export const API_BASE = env.VITE_API_BASE || "/api";

// Query string from an object or a list of [key, value] pairs. Arrays repeat
// the key (set=lea&set=leb), which is how facet selections travel. Drops
// null/undefined/"" values.
export function buildQuery(params = {}) {
  const pairs = Array.isArray(params) ? params : Object.entries(params);
  const qs = new URLSearchParams();
  for (const [k, v] of pairs) {
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one === null || one === undefined || one === "") continue;
      qs.append(k, String(one));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

// /v1/storefront/{slug}{path}, with the slug encoded.
export function storePath(slug, path = "") {
  if (!slug) throw new Error("storefront slug is required");
  return `/v1/storefront/${encodeURIComponent(slug)}${path}`;
}

// An API failure. `detail` is FastAPI's error detail as sent: a string, a
// validation error list (422), or an object such as the order endpoint's
// 409 {message, issues}.
export class ApiError extends Error {
  constructor(status, detail) {
    super(errorMessage(status, { detail }));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  // Per-line issues of a 409 from POST /orders ([] when there are none).
  get issues() {
    const d = this.detail;
    return d && typeof d === "object" && Array.isArray(d.issues) ? d.issues : [];
  }
}

const STATUS_MESSAGES = {
  404: "Not found",
  429: "Too many requests — please wait a moment and try again",
  503: "Temporarily unavailable — please try again in a moment",
};

// Human message from a FastAPI error body.
export function errorMessage(status, body) {
  const detail = body && body.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length > 0 && detail[0] && detail[0].msg) {
    const loc = Array.isArray(detail[0].loc) ? detail[0].loc.slice(1).join(".") : "";
    return loc ? `${loc}: ${detail[0].msg}` : detail[0].msg;
  }
  if (detail && typeof detail === "object" && typeof detail.message === "string") {
    return detail.message;
  }
  return STATUS_MESSAGES[status] || `API error ${status}`;
}

export async function request(method, path, { params, json, signal, base = API_BASE } = {}) {
  const headers = { Accept: "application/json" };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const resp = await fetch(`${base}${path}${buildQuery(params)}`, {
    method,
    signal,
    headers,
    body,
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    throw new ApiError(resp.status, errBody && errBody.detail);
  }
  return resp.json();
}

export const isAbortError = (e) => Boolean(e) && e.name === "AbortError";

// GET "" → {slug, display_name, pickup_location: {id, name}, pickup_text,
// policy_text, reservation_hours}
export const getStore = (slug, opts) => request("GET", storePath(slug), opts);

// GET /search with params from searchState.toRequestParams (a pair list, so
// facets repeat). Response: tcg_search shape_search().
export const searchStore = (slug, params, opts) =>
  request("GET", storePath(slug, "/search"), { ...opts, params });

// GET /autocomplete?q= → tcg_search autocomplete(): a list of
// {oracle_id, name, image_small, price_cents, in_stock, type_line}.
export const autocomplete = (slug, q, opts) =>
  request("GET", storePath(slug, "/autocomplete"), { ...opts, params: { q } }).then(
    autocompleteItems,
  );

// The suggestion list, whether the route returns the bare list or wraps it.
export function autocompleteItems(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const key of ["results", "suggestions", "items"]) {
      if (Array.isArray(body[key])) return body[key];
    }
  }
  return [];
}

// GET /cards/{oracle_id} → {card, offers: {printing_id: [offer]}}
export const getCard = (slug, oracleId, opts) =>
  request("GET", storePath(slug, `/cards/${encodeURIComponent(oracleId)}`), opts);

// POST /cart/quote {lines} → {ok, total_cents, lines: [CartLineResult]}
export const quoteCart = (slug, body, opts) =>
  request("POST", storePath(slug, "/cart/quote"), { ...opts, json: body });

// POST /orders {idempotency_key, customer, lines} → WebOrderPublic (201 new,
// 200 replay); 409 ApiError with .issues.
export const createOrder = (slug, body, opts) =>
  request("POST", storePath(slug, "/orders"), { ...opts, json: body });

// GET /orders/{id}?code= → WebOrderPublic
export const getOrder = (slug, orderId, code, opts) =>
  request("GET", storePath(slug, `/orders/${encodeURIComponent(orderId)}`), {
    ...opts,
    params: { code },
  });
