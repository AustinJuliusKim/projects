// Cart model: a pure reducer over a plain object, one cart per store slug in
// localStorage (mtg-webapp deck.js pattern — storage stays at the edges).
// The server is the truth for price and stock: the cart is re-quoted
// (POST /cart/quote) on load and each line carries the price the customer
// saw, so a change is flagged instead of silently charged.
//
// Limits mirror tcg-pos-api routes/models.py: 40 lines, 20 copies per line.

export const ORDER_LINES_MAX = 40;
export const LINE_QTY_MAX = 20;
const STORAGE_PREFIX = "tcg-storefront:cart:";
const ATTEMPT_PREFIX = "tcg-storefront:checkout:";

export function emptyCart() {
  return { lines: [] };
}

const isId = (v) => typeof v === "string" && v.length > 0;
const isCents = (v) => Number.isSafeInteger(v) && v >= 0;

// Display fields kept with a line (the quote only returns ids and prices).
const INFO_FIELDS = [
  "oracle_id",
  "name",
  "printing_id",
  "set_code",
  "set_name",
  "collector_number",
  "finish",
  "condition",
  "lang",
  "image_small",
];

function cleanLine(raw) {
  if (!raw || typeof raw !== "object" || !isId(raw.inventory_item_id)) return null;
  const qty = Number(raw.qty);
  if (!Number.isInteger(qty) || qty < 1) return null;
  const line = {
    inventory_item_id: raw.inventory_item_id,
    qty: Math.min(qty, LINE_QTY_MAX),
    unit_price_cents: isCents(raw.unit_price_cents) ? raw.unit_price_cents : null,
    available: Number.isInteger(raw.available) ? raw.available : null,
  };
  for (const f of INFO_FIELDS) line[f] = raw[f] ?? null;
  return line;
}

// Whatever came out of storage → a valid cart (bad lines dropped, duplicate
// items merged, limits applied). Never throws.
export function sanitizeCart(raw) {
  const out = emptyCart();
  const lines = raw && Array.isArray(raw.lines) ? raw.lines : [];
  for (const r of lines) {
    const line = cleanLine(r);
    if (!line) continue;
    const existing = out.lines.find((l) => l.inventory_item_id === line.inventory_item_id);
    if (existing) existing.qty = Math.min(existing.qty + line.qty, LINE_QTY_MAX);
    else if (out.lines.length < ORDER_LINES_MAX) out.lines.push(line);
  }
  return out;
}

const maxQty = (available) =>
  Number.isInteger(available) && available >= 0 ? Math.min(available, LINE_QTY_MAX) : LINE_QTY_MAX;

export function findLine(cart, id) {
  return cart.lines.find((l) => l.inventory_item_id === id) || null;
}

// Can `qty` more of this item go in the cart?
export function canAdd(cart, item, qty = 1) {
  const line = findLine(cart, item.inventory_item_id);
  if (!line && cart.lines.length >= ORDER_LINES_MAX) return false;
  const have = line ? line.qty : 0;
  return have + qty <= maxQty(item.available ?? (line && line.available));
}

export function cartReducer(cart, action) {
  switch (action.type) {
    case "add": {
      const item = cleanLine({ ...action.item, qty: action.qty ?? 1 });
      if (!item) return cart;
      const line = findLine(cart, item.inventory_item_id);
      if (line) {
        const qty = Math.min(line.qty + item.qty, maxQty(item.available ?? line.available));
        return {
          ...cart,
          lines: cart.lines.map((l) =>
            l === line ? { ...l, ...item, qty: Math.max(qty, l.qty) } : l,
          ),
        };
      }
      if (cart.lines.length >= ORDER_LINES_MAX) return cart;
      return {
        ...cart,
        lines: [...cart.lines, { ...item, qty: Math.min(item.qty, maxQty(item.available)) }],
      };
    }
    case "setQty": {
      const qty = Number(action.qty);
      if (!Number.isFinite(qty) || qty < 1) return cartReducer(cart, { type: "remove", id: action.id });
      return {
        ...cart,
        lines: cart.lines.map((l) =>
          l.inventory_item_id === action.id ? { ...l, qty: Math.min(Math.floor(qty), LINE_QTY_MAX) } : l,
        ),
      };
    }
    case "remove":
      return { ...cart, lines: cart.lines.filter((l) => l.inventory_item_id !== action.id) };
    case "clear":
      return emptyCart();
    case "replace":
      return sanitizeCart(action.cart);
    case "applyQuote":
      return applyQuote(cart, action.quote);
    default:
      return cart;
  }
}

// Accept what the server said: take live prices, cut quantities to what is
// available, drop lines that can't be bought. Lines the quote doesn't
// mention are kept as they are.
export function applyQuote(cart, quote) {
  const results = quoteResults(quote);
  const lines = [];
  for (const line of cart.lines) {
    const r = results.get(line.inventory_item_id);
    if (!r) {
      lines.push(line);
      continue;
    }
    if (r.status === "not_found" || r.status === "not_priced") continue;
    const available = Number.isInteger(r.available) ? r.available : line.available;
    const qty = r.status === "insufficient" ? Math.min(line.qty, available ?? 0) : line.qty;
    if (qty < 1) continue;
    lines.push({
      ...line,
      qty,
      available,
      unit_price_cents: isCents(r.unit_price_cents) ? r.unit_price_cents : line.unit_price_cents,
    });
  }
  return { ...cart, lines };
}

function quoteResults(quote) {
  const map = new Map();
  for (const r of (quote && Array.isArray(quote.lines) && quote.lines) || []) {
    if (r && isId(r.inventory_item_id)) map.set(r.inventory_item_id, r);
  }
  return map;
}

// --- request bodies ---------------------------------------------------------------

export function quoteLines(cart) {
  return cart.lines.map((l) => {
    const out = { inventory_item_id: l.inventory_item_id, qty: l.qty };
    if (isCents(l.unit_price_cents)) out.unit_price_cents = l.unit_price_cents;
    return out;
  });
}

// POST /cart/quote body
export const quoteBody = (cart) => ({ lines: quoteLines(cart) });

// POST /orders body
export function orderBody(cart, customer, idempotencyKey) {
  const phone = (customer.phone || "").trim();
  return {
    idempotency_key: idempotencyKey,
    customer: {
      name: (customer.name || "").trim(),
      email: (customer.email || "").trim(),
      phone: phone || null,
    },
    lines: quoteLines(cart),
  };
}

// --- quote → view -----------------------------------------------------------------

export function issueText(result) {
  if (!result) return null;
  const available = Number.isInteger(result.available) ? result.available : 0;
  switch (result.status) {
    case "not_found":
      return "No longer available";
    case "not_priced":
      return "No longer for sale online";
    case "insufficient":
      return available > 0 ? `Only ${available} available` : "Sold out";
    case "price_changed":
      return "Price changed";
    default:
      return null;
  }
}

// Cart lines joined with a quote's results. status is "pending" for a line
// the quote doesn't cover (the cart changed since it was requested).
export function mergeQuote(cart, quote) {
  const results = quoteResults(quote);
  const rows = cart.lines.map((line) => {
    const result = results.get(line.inventory_item_id) || null;
    const status = result ? result.status : "pending";
    return {
      line,
      result,
      status,
      issue: issueText(result),
      livePriceCents:
        result && isCents(result.unit_price_cents) ? result.unit_price_cents : line.unit_price_cents,
    };
  });
  const issues = rows.filter((r) => r.issue);
  const complete = rows.every((r) => r.result);
  return {
    rows,
    issues,
    ok: Boolean(quote && quote.ok) && complete && issues.length === 0 && rows.length > 0,
    totalCents: complete && quote && isCents(quote.total_cents) ? quote.total_cents : null,
  };
}

// Issues from a 409 POST /orders, keyed by inventory_item_id.
export function issuesById(issues) {
  const out = {};
  for (const r of issues || []) {
    if (r && isId(r.inventory_item_id) && r.status !== "ok") out[r.inventory_item_id] = r;
  }
  return out;
}

export function cartCount(cart) {
  return cart.lines.reduce((n, l) => n + l.qty, 0);
}

// Subtotal at the prices the customer saw; null if any line is unpriced.
export function cartSubtotal(cart) {
  let total = 0;
  for (const l of cart.lines) {
    if (!isCents(l.unit_price_cents)) return null;
    total += l.unit_price_cents * l.qty;
  }
  return total;
}

// --- checkout attempt (idempotency) ------------------------------------------------

// What the order would reserve. A retry of the same cart reuses its key; a
// changed cart is a new attempt (the server rejects a reused key for a
// different cart).
export function cartFingerprint(cart) {
  return quoteLines(cart)
    .map((l) => `${l.inventory_item_id}:${l.qty}:${l.unit_price_cents ?? ""}`)
    .sort()
    .join("|");
}

export function newIdempotencyKey(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === "function") {
    cryptoImpl.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The attempt for this cart: the existing one if the cart is unchanged,
// otherwise a fresh key.
export function ensureAttempt(attempt, cart, makeKey = newIdempotencyKey) {
  const fingerprint = cartFingerprint(cart);
  if (attempt && attempt.fingerprint === fingerprint && isId(attempt.key)) return attempt;
  return { key: makeKey(), fingerprint };
}

// --- customer -----------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[0-9+()\-. ]{4,40}$/;

// Field errors, mirroring the server's Customer model ({} when valid).
export function validateCustomer(customer) {
  const errors = {};
  const name = (customer.name || "").trim();
  const email = (customer.email || "").trim();
  const phone = (customer.phone || "").trim();
  if (!name) errors.name = "Enter your name";
  else if (name.length > 100) errors.name = "Name is too long";
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = "Enter a valid email";
  if (phone && !PHONE_RE.test(phone)) errors.phone = "Enter a valid phone number";
  return errors;
}

// --- storage (edges) ----------------------------------------------------------------

export const cartStorageKey = (slug) => `${STORAGE_PREFIX}${slug}`;
export const attemptStorageKey = (slug) => `${ATTEMPT_PREFIX}${slug}`;

function readJson(storage, key) {
  try {
    const raw = storage && storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode): the cart still works in memory.
  }
}

const local = () => (typeof localStorage === "undefined" ? null : localStorage);
const session = () => (typeof sessionStorage === "undefined" ? null : sessionStorage);

export function loadCart(slug, storage = local()) {
  return sanitizeCart(readJson(storage, cartStorageKey(slug)));
}

export function saveCart(slug, cart, storage = local()) {
  writeJson(storage, cartStorageKey(slug), cart.lines.length ? cart : null);
}

export function loadAttempt(slug, storage = session()) {
  return readJson(storage, attemptStorageKey(slug));
}

export function saveAttempt(slug, attempt, storage = session()) {
  writeJson(storage, attemptStorageKey(slug), attempt);
}
