import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsage, addUsage, totalTokens, capExceeded, usagePayload } from "./usage.mjs";

test("accumulates across runs", () => {
  const u = createUsage(1000);
  addUsage(u, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, costUsd: 0.01 });
  addUsage(u, { inputTokens: 200, outputTokens: 70, cacheReadTokens: 5, costUsd: 0.02 });
  assert.equal(u.runs, 2);
  assert.equal(u.inputTokens, 300);
  assert.equal(u.outputTokens, 120);
  assert.equal(totalTokens(u), 300 + 120 + 15);
  assert.ok(Math.abs(u.costUsd - 0.03) < 1e-9);
});

test("cap enforcement", () => {
  const u = createUsage(100);
  assert.ok(!capExceeded(u));
  addUsage(u, { inputTokens: 60, outputTokens: 50, cacheReadTokens: 0, costUsd: 0 });
  assert.ok(capExceeded(u));
});

test("no cap means never exceeded", () => {
  const u = createUsage(0); // 0/undefined -> Infinity
  addUsage(u, { inputTokens: 1e9, outputTokens: 1e9, cacheReadTokens: 0, costUsd: 0 });
  assert.ok(!capExceeded(u));
  assert.equal(usagePayload(u).tokenCap, null);
});
