import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyQuote,
  canAdd,
  cartCount,
  cartFingerprint,
  cartReducer,
  cartSubtotal,
  emptyCart,
  ensureAttempt,
  issuesById,
  LINE_QTY_MAX,
  loadAttempt,
  loadCart,
  mergeQuote,
  newIdempotencyKey,
  ORDER_LINES_MAX,
  orderBody,
  quoteBody,
  sanitizeCart,
  saveAttempt,
  saveCart,
  validateCustomer,
} from "../src/cart.js";
import { ITEM_A, ITEM_B, ITEM_C, order409, quoteWithIssues } from "./fixtures.js";

const item = (id, price = 199, available = 4, extra = {}) => ({
  inventory_item_id: id,
  unit_price_cents: price,
  available,
  name: "Lightning Bolt",
  set_code: "m10",
  condition: "NM",
  finish: "nonfoil",
  lang: "en",
  ...extra,
});

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function cartOf(...specs) {
  return specs.reduce(
    (c, [it, qty]) => cartReducer(c, { type: "add", item: it, qty }),
    emptyCart(),
  );
}

test("add merges quantities and caps at what is available", () => {
  let c = cartReducer(emptyCart(), { type: "add", item: item(ITEM_A), qty: 2 });
  c = cartReducer(c, { type: "add", item: item(ITEM_A), qty: 1 });
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].qty, 3);
  c = cartReducer(c, { type: "add", item: item(ITEM_A), qty: 5 });
  assert.equal(c.lines[0].qty, 4);
  assert.equal(canAdd(c, item(ITEM_A)), false);
  assert.equal(canAdd(c, item(ITEM_B)), true);
  assert.equal(cartCount(c), 4);
});

test("add caps at the per-line max and rejects garbage", () => {
  const c = cartReducer(emptyCart(), { type: "add", item: item(ITEM_A, 1, 500), qty: 99 });
  assert.equal(c.lines[0].qty, LINE_QTY_MAX);
  assert.equal(cartReducer(c, { type: "add", item: { qty: 1 } }), c);
  assert.equal(cartReducer(c, { type: "add", item: item(ITEM_B), qty: 0 }), c);
});

test("line count is capped", () => {
  let c = emptyCart();
  for (let i = 0; i < ORDER_LINES_MAX + 3; i++) {
    c = cartReducer(c, { type: "add", item: item(`item-${i}`) });
  }
  assert.equal(c.lines.length, ORDER_LINES_MAX);
  assert.equal(canAdd(c, item("another")), false);
});

test("setQty, remove, clear", () => {
  let c = cartOf([item(ITEM_A), 1], [item(ITEM_B), 1]);
  c = cartReducer(c, { type: "setQty", id: ITEM_A, qty: 3 });
  assert.equal(c.lines[0].qty, 3);
  c = cartReducer(c, { type: "setQty", id: ITEM_A, qty: 0 });
  assert.deepEqual(c.lines.map((l) => l.inventory_item_id), [ITEM_B]);
  c = cartReducer(c, { type: "remove", id: ITEM_B });
  assert.equal(c.lines.length, 0);
  assert.deepEqual(cartReducer(cartOf([item(ITEM_A), 1]), { type: "clear" }), emptyCart());
  assert.equal(cartReducer(c, { type: "unknown" }), c);
});

test("sanitizeCart survives junk from storage", () => {
  assert.deepEqual(sanitizeCart(null), emptyCart());
  assert.deepEqual(sanitizeCart({ lines: "nope" }), emptyCart());
  const c = sanitizeCart({
    lines: [
      { inventory_item_id: ITEM_A, qty: 2, unit_price_cents: 1.5 },
      { inventory_item_id: ITEM_A, qty: 1 },
      { inventory_item_id: "", qty: 1 },
      { inventory_item_id: ITEM_B, qty: -1 },
      null,
    ],
  });
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].qty, 3);
  assert.equal(c.lines[0].unit_price_cents, null);
});

test("per-slug storage round trip; empty cart removes the key", () => {
  const storage = memoryStorage();
  const c = cartOf([item(ITEM_A), 2]);
  saveCart("demo", c, storage);
  assert.deepEqual(loadCart("demo", storage), c);
  assert.deepEqual(loadCart("other", storage), emptyCart());
  saveCart("demo", emptyCart(), storage);
  assert.equal(storage.data.size, 0);
  storage.setItem("tcg-storefront:cart:demo", "{not json");
  assert.deepEqual(loadCart("demo", storage), emptyCart());
  assert.deepEqual(loadCart("demo", null), emptyCart());
});

test("quote and order bodies carry the price the customer saw", () => {
  const c = cartOf([item(ITEM_A), 2], [item(ITEM_B, null), 1]);
  assert.deepEqual(quoteBody(c), {
    lines: [
      { inventory_item_id: ITEM_A, qty: 2, unit_price_cents: 199 },
      { inventory_item_id: ITEM_B, qty: 1 },
    ],
  });
  assert.deepEqual(orderBody(c, { name: " Ann ", email: "a@b.co ", phone: " " }, "key-12345"), {
    idempotency_key: "key-12345",
    customer: { name: "Ann", email: "a@b.co", phone: null },
    lines: quoteBody(c).lines,
  });
});

test("mergeQuote flags gone / insufficient / price_changed lines", () => {
  const c = cartOf([item(ITEM_A), 2], [item(ITEM_B, 199, 3), 3], [item(ITEM_C, 45000, 1), 1]);
  const view = mergeQuote(c, quoteWithIssues);
  assert.equal(view.ok, false);
  assert.deepEqual(
    view.rows.map((r) => [r.status, r.issue, r.livePriceCents]),
    [
      ["ok", null, 199],
      ["insufficient", "Only 1 available", 199],
      ["price_changed", "Price changed", 40000],
    ],
  );
  assert.equal(view.issues.length, 2);
  assert.equal(view.totalCents, 398);

  const okQuote = { ok: true, total_cents: 398, lines: [quoteWithIssues.lines[0]] };
  const one = cartOf([item(ITEM_A), 2]);
  assert.equal(mergeQuote(one, okQuote).ok, true);
  // A line the quote doesn't cover yet is pending, and blocks checkout.
  const two = cartReducer(one, { type: "add", item: item(ITEM_B) });
  const pending = mergeQuote(two, okQuote);
  assert.equal(pending.rows[1].status, "pending");
  assert.equal(pending.ok, false);
  assert.equal(pending.totalCents, null);
  assert.equal(mergeQuote(emptyCart(), { ok: true, total_cents: 0, lines: [] }).ok, false);
  assert.equal(mergeQuote(one, null).ok, false);
});

test("issue text for every status", () => {
  const c = cartOf([item(ITEM_A), 1]);
  const at = (status, available) =>
    mergeQuote(c, { ok: false, total_cents: 0, lines: [{ inventory_item_id: ITEM_A, status, available }] })
      .rows[0].issue;
  assert.equal(at("not_found", 0), "No longer available");
  assert.equal(at("not_priced", 0), "No longer for sale online");
  assert.equal(at("insufficient", 0), "Sold out");
  assert.equal(at("ok", 3), null);
});

test("applyQuote accepts live prices, trims quantities, drops dead lines", () => {
  const c = cartOf(
    [item(ITEM_A), 2],
    [item(ITEM_B, 199, 3), 3],
    [item(ITEM_C, 45000, 1), 1],
    [item("gone"), 1],
    [item("untouched"), 1],
  );
  const quote = {
    ...quoteWithIssues,
    lines: [...quoteWithIssues.lines, { inventory_item_id: "gone", qty: 1, status: "not_found", available: 0 }],
  };
  const next = applyQuote(c, quote);
  assert.deepEqual(
    next.lines.map((l) => [l.inventory_item_id, l.qty, l.unit_price_cents]),
    [
      [ITEM_A, 2, 199],
      [ITEM_B, 1, 199],
      [ITEM_C, 1, 40000],
      ["untouched", 1, 199],
    ],
  );
  assert.deepEqual(cartReducer(c, { type: "applyQuote", quote }), next);
  // A sold-out insufficient line is removed.
  const soldOut = applyQuote(cartOf([item(ITEM_A), 2]), {
    lines: [{ inventory_item_id: ITEM_A, status: "insufficient", available: 0 }],
  });
  assert.equal(soldOut.lines.length, 0);
});

test("409 issues are keyed by item", () => {
  const byId = issuesById(order409.detail.issues);
  assert.deepEqual(Object.keys(byId), [ITEM_B, ITEM_C]);
  assert.deepEqual(issuesById(undefined), {});
});

test("subtotal is null when anything is unpriced", () => {
  assert.equal(cartSubtotal(cartOf([item(ITEM_A), 2], [item(ITEM_B, 500), 1])), 898);
  assert.equal(cartSubtotal(cartOf([item(ITEM_A, null), 1])), null);
  assert.equal(cartSubtotal(emptyCart()), 0);
});

test("idempotency key is kept for retries of the same cart only", () => {
  let n = 0;
  const make = () => `key-${++n}-abcdef`;
  const c = cartOf([item(ITEM_A), 2], [item(ITEM_B), 1]);
  const first = ensureAttempt(null, c, make);
  assert.equal(first.key, "key-1-abcdef");
  assert.equal(ensureAttempt(first, c, make), first);
  // Same lines in another order: same attempt.
  const reordered = { lines: [...c.lines].reverse() };
  assert.equal(cartFingerprint(reordered), cartFingerprint(c));
  assert.equal(ensureAttempt(first, reordered, make), first);
  // A changed cart is a new attempt.
  const changed = cartReducer(c, { type: "setQty", id: ITEM_A, qty: 1 });
  assert.equal(ensureAttempt(first, changed, make).key, "key-2-abcdef");
  assert.equal(ensureAttempt({ fingerprint: first.fingerprint }, c, make).key, "key-3-abcdef");
});

test("attempts persist per slug", () => {
  const storage = memoryStorage();
  saveAttempt("demo", { key: "k", fingerprint: "f" }, storage);
  assert.deepEqual(loadAttempt("demo", storage), { key: "k", fingerprint: "f" });
  saveAttempt("demo", null, storage);
  assert.equal(loadAttempt("demo", storage), null);
});

test("generated keys match the server's pattern", () => {
  const pattern = /^[A-Za-z0-9_-]{8,100}$/;
  assert.match(newIdempotencyKey(), pattern);
  assert.match(newIdempotencyKey({}), pattern);
  assert.match(newIdempotencyKey({ getRandomValues: (b) => b.fill(7) }), pattern);
});

test("validateCustomer mirrors the server's rules", () => {
  assert.deepEqual(validateCustomer({ name: "Ann", email: "ann@example.com" }), {});
  assert.deepEqual(validateCustomer({ name: "Ann", email: "a@b.co", phone: "+1 (555) 123-4567" }), {});
  assert.deepEqual(Object.keys(validateCustomer({ name: " ", email: "nope", phone: "abc" })), [
    "name",
    "email",
    "phone",
  ]);
});
