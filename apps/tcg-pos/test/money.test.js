import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCents } from "../src/money.js";

test("formatCents formats integer cents as dollars", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(1234), "$12.34");
  assert.equal(formatCents(123456789), "$1,234,567.89");
  assert.equal(formatCents(-5), "-$0.05");
  assert.equal(formatCents(-1999), "-$19.99");
});

test("formatCents renders unknown as the fallback, never $0.00", () => {
  assert.equal(formatCents(null), "—");
  assert.equal(formatCents(undefined), "—");
  assert.equal(formatCents(null, { fallback: "unpriced" }), "unpriced");
});

test("formatCents refuses non-integer input", () => {
  for (const bad of [12.5, "1234", NaN, Infinity, 2 ** 60]) {
    assert.throws(() => formatCents(bad), TypeError, String(bad));
  }
});
