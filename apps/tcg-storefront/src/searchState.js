// Search state lives in the URL (shareable, back-button friendly), the way
// mtg-webapp's SearchPage does it. This module is the only place that maps
// URL params ↔ state ↔ the API request, so tests pin both directions.
//
// URL / API params (identical, so a search URL is also its API query):
//   q, mode (stock|catalog), sort, page, page_size, and one repeated param
//   per facet selection: set=lea&set=leb&colors=R
// Names, sorts and sizes mirror services/tcg-search query/build.py.

export const MODES = ["stock", "catalog"];
export const DEFAULT_MODE = "stock";

export const SORTS = ["relevance", "popular", "name", "price_asc", "price_desc", "newest", "mv"];
export const DEFAULT_SORT = "relevance";
export const SORT_LABELS = {
  relevance: "Best match",
  popular: "Most popular",
  name: "Name",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  newest: "Newest",
  mv: "Mana value",
};

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;
export const PAGE_SIZES = [24, 48, 96];
export const MAX_WINDOW = 2400; // page * page_size cap on the server

// facet_names(index_kind) in build.py; condition exists only for listings.
const CATALOG_FACETS = ["set", "rarity", "finish", "price", "colors", "identity", "types",
  "keywords", "format"];
export const FACET_NAMES = {
  catalog: CATALOG_FACETS,
  stock: [...CATALOG_FACETS.slice(0, 3), "condition", ...CATALOG_FACETS.slice(3)],
};
export const ALL_FACETS = FACET_NAMES.stock;

function positiveInt(raw, fallback, max = Infinity) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function emptyState() {
  return {
    q: "",
    mode: DEFAULT_MODE,
    sort: DEFAULT_SORT,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    facets: {},
  };
}

// URLSearchParams (or a query string) → state. Unknown params and values
// are dropped; facet values keep URL order with duplicates removed.
export function parseSearchParams(input) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input || "");
  const state = emptyState();
  state.q = (params.get("q") || "").trim();
  const mode = params.get("mode");
  if (MODES.includes(mode)) state.mode = mode;
  const sort = params.get("sort");
  if (SORTS.includes(sort)) state.sort = sort;
  state.page = positiveInt(params.get("page"), 1);
  state.pageSize = positiveInt(params.get("page_size"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  for (const name of ALL_FACETS) {
    const values = [];
    for (const v of params.getAll(name)) {
      const t = v.trim();
      if (t && !values.includes(t)) values.push(t);
    }
    if (values.length) state.facets[name] = values;
  }
  return state;
}

// State → [key, value] pairs, defaults omitted. `forApi` keeps every param
// the server needs (mode is always sent), and drops facets the mode doesn't
// have (condition in catalog mode) so the server doesn't warn about them.
export function toParamPairs(state, { forApi = false } = {}) {
  const s = { ...emptyState(), ...state };
  const pairs = [];
  if (s.q) pairs.push(["q", s.q]);
  if (forApi || s.mode !== DEFAULT_MODE) pairs.push(["mode", s.mode]);
  if (s.sort && s.sort !== DEFAULT_SORT) pairs.push(["sort", s.sort]);
  if (s.page > 1) pairs.push(["page", String(s.page)]);
  if (forApi || s.pageSize !== DEFAULT_PAGE_SIZE) pairs.push(["page_size", String(s.pageSize)]);
  const names = forApi ? FACET_NAMES[s.mode] || ALL_FACETS : ALL_FACETS;
  for (const name of names) {
    for (const v of (s.facets && s.facets[name]) || []) pairs.push([name, v]);
  }
  return pairs;
}

export function toSearchParams(state) {
  return new URLSearchParams(toParamPairs(state));
}

// The API request for this state: pairs for api.searchStore.
export function toRequestParams(state) {
  return toParamPairs(state, { forApi: true });
}

// Search page URL (relative to the store) for a state.
export function searchHref(slug, state) {
  const qs = toSearchParams(state).toString();
  return `/s/${encodeURIComponent(slug)}/search${qs ? `?${qs}` : ""}`;
}

// Apply a change. Anything other than paging resets to page 1, and
// switching mode drops facets the new mode doesn't support.
export function patchState(state, patch) {
  const next = { ...state, ...patch };
  if (!("page" in patch)) next.page = 1;
  if ("mode" in patch && patch.mode !== state.mode) {
    const allowed = FACET_NAMES[next.mode] || ALL_FACETS;
    next.facets = Object.fromEntries(
      Object.entries(next.facets || {}).filter(([k]) => allowed.includes(k)),
    );
  }
  return next;
}

// Last page a client can reach (the server caps page * page_size).
export function pageCount(total, pageSize) {
  const size = positiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const n = Math.max(1, Math.ceil((Number(total) || 0) / size));
  return Math.min(n, Math.max(1, Math.floor(MAX_WINDOW / size)));
}

export function hasCriteria(state) {
  return Boolean(state.q) || Object.keys(state.facets || {}).length > 0;
}

// Autocomplete is a name-prefix lookup: only worth asking for plain text of
// two or more characters, not syntax like "t:dragon" or "-goblin".
export function shouldSuggest(text) {
  const t = (text || "").trim();
  if (t.length < 2 || t.length > 100) return false;
  return !/[:<>=!"]/.test(t) && !/(^|\s)-/.test(t);
}
