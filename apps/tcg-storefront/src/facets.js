// Facet labels, multi-select toggling and query chips. Facet rows and
// clauses come straight from the search response (tcg_search shape.py):
//   facets: {name: [{value, count, selected, label?}]}
//   query.clauses: [{key, op, value, negated, raw, source: "q"|"facet", phrase?}]

import { patchState } from "./searchState.js";

export const FACET_LABELS = {
  set: "Set",
  rarity: "Rarity",
  finish: "Finish",
  condition: "Condition",
  price: "Price",
  colors: "Color",
  identity: "Color identity",
  types: "Card type",
  keywords: "Keyword",
  format: "Legal in",
};

export const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless" };
export const CONDITION_LABELS = {
  NM: "Near Mint",
  LP: "Lightly Played",
  MP: "Moderately Played",
  HP: "Heavily Played",
  DMG: "Damaged",
};
// cond:<rank> in typed syntax (syntax.py CONDITION_NAMES)
const CONDITION_RANKS = { 5: "NM", 4: "LP", 3: "MP", 2: "HP", 1: "DMG" };
export const FINISH_LABELS = { nonfoil: "Non-foil", foil: "Foil", etched: "Etched" };
// build.py PRICE_BANDS (the server also sends the label on each price row)
export const PRICE_BAND_LABELS = {
  "0-100": "Under $1",
  "100-500": "$1–5",
  "500-2000": "$5–20",
  "2000-5000": "$20–50",
  "5000-10000": "$50–100",
  "10000-": "$100+",
};

const capitalize = (s) =>
  String(s)
    .split(/([\s-])/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join("");

// Display label for one facet value (a facet row or a bare value).
export function valueLabel(name, row) {
  const value = row && typeof row === "object" ? row.value : row;
  if (row && typeof row === "object" && row.label) return row.label;
  const v = String(value ?? "");
  switch (name) {
    case "colors":
    case "identity":
      return COLOR_NAMES[v.toUpperCase()] || v.toUpperCase();
    case "condition":
      return CONDITION_LABELS[v.toUpperCase()] || v.toUpperCase();
    case "finish":
      return FINISH_LABELS[v.toLowerCase()] || capitalize(v);
    case "price":
      return PRICE_BAND_LABELS[v] || v;
    case "set":
      return v.toUpperCase();
    default:
      return capitalize(v);
  }
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function isSelected(facets, name, value) {
  return ((facets && facets[name]) || []).some((v) => same(v, value));
}

// Add or remove one value of a multi-select facet. Returns new facets; an
// emptied facet is removed entirely.
export function toggleFacet(facets, name, value) {
  const current = (facets && facets[name]) || [];
  const next = isSelected(facets, name, value)
    ? current.filter((v) => !same(v, value))
    : [...current, String(value)];
  const out = { ...(facets || {}) };
  if (next.length) out[name] = next;
  else delete out[name];
  return out;
}

export function clearFacet(facets, name) {
  const out = { ...(facets || {}) };
  delete out[name];
  return out;
}

// Facets to render, in response order, each with display labels.
// Facets with no rows are skipped.
export function facetGroups(responseFacets) {
  return Object.entries(responseFacets || {})
    .filter(([, rows]) => Array.isArray(rows) && rows.length)
    .map(([name, rows]) => ({
      name,
      label: FACET_LABELS[name] || capitalize(name),
      rows: rows.map((r) => ({
        value: String(r.value),
        label: valueLabel(name, r),
        count: Number(r.count) || 0,
        selected: Boolean(r.selected),
      })),
    }));
}

// --- chips --------------------------------------------------------------------

const KEY_LABELS = {
  t: "Type",
  o: "Text",
  c: "Color",
  id: "Identity",
  s: "Set",
  r: "Rarity",
  mv: "Mana value",
  pow: "Power",
  tou: "Toughness",
  loy: "Loyalty",
  f: "Legal in",
  banned: "Banned in",
  restricted: "Restricted in",
  kw: "Keyword",
  a: "Artist",
  name: "Name",
  is: "Is",
  cond: "Condition",
  usd: "Price",
};

function colorsLabel(letters) {
  if (letters === "") return "Colorless";
  if (letters === "M") return "Multicolor";
  return String(letters)
    .split("")
    .map((ch) => COLOR_NAMES[ch] || ch)
    .join(", ");
}

function typedValue(key, value) {
  if (key === "c" || key === "id") return colorsLabel(value);
  if (key === "s" && value && typeof value === "object") {
    return value.name || String(value.code || "").toUpperCase();
  }
  if (key === "cond") return CONDITION_RANKS[value] || String(value);
  if (key === "usd") {
    const n = Number(value);
    return Number.isFinite(n) ? `$${Number.isInteger(n) ? n : n.toFixed(2)}` : String(value);
  }
  if (key === "r" || key === "f" || key === "banned" || key === "restricted") {
    return capitalize(value);
  }
  return String(value);
}

// Chip label for one echoed clause.
export function clauseLabel(clause) {
  const neg = clause.negated ? "not " : "";
  if (clause.key === null || clause.key === undefined) {
    return `${neg}“${clause.value}”`;
  }
  if (clause.source === "facet") {
    const values = Array.isArray(clause.value) ? clause.value : [clause.value];
    const label = FACET_LABELS[clause.key] || capitalize(clause.key);
    return `${label}: ${values.map((v) => valueLabel(clause.key, v)).join(" or ")}`;
  }
  const key = KEY_LABELS[clause.key] || clause.key;
  const op = clause.op === ":" || clause.op === "=" ? ": " : ` ${clause.op} `;
  return `${neg}${key}${op}${typedValue(clause.key, clause.value)}`;
}

// One chip per filter-like clause. Plain free-text words are the search box
// itself, so they don't get chips; phrases and negations do.
export function clauseChips(clauses) {
  const chips = [];
  (clauses || []).forEach((c, i) => {
    if (!c) return;
    const plainText = (c.key === null || c.key === undefined) && !c.negated && !c.phrase;
    if (plainText) return;
    chips.push({
      id: `${c.source || "q"}:${i}:${c.raw}`,
      label: clauseLabel(c),
      source: c.source === "facet" ? "facet" : "q",
      key: c.key,
      raw: c.raw || "",
    });
  });
  return chips;
}

// Remove one whitespace-delimited occurrence of `raw` from a query string.
export function removeRaw(q, raw) {
  if (!raw) return q;
  let from = 0;
  while (from <= q.length) {
    const i = q.indexOf(raw, from);
    if (i < 0) return q;
    const before = i === 0 || /\s/.test(q[i - 1]);
    const end = i + raw.length;
    const after = end === q.length || /\s/.test(q[end]);
    if (before && after) {
      return `${q.slice(0, i)} ${q.slice(end)}`.replace(/\s+/g, " ").trim();
    }
    from = i + 1;
  }
  return q;
}

// The search state with a chip removed: a facet chip clears that facet; a
// typed chip removes its raw text from q.
export function removeChip(state, chip) {
  if (chip.source === "facet") {
    return patchState(state, { facets: clearFacet(state.facets, chip.key) });
  }
  return patchState(state, { q: removeRaw(state.q, chip.raw) });
}
