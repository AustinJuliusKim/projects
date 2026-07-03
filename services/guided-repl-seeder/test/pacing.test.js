import test from "node:test";
import assert from "node:assert/strict";

import { computePacing } from "../src/pacing.js";

test("first event has delayMs and origDelayMs 0", () => {
  const out = computePacing([{ frame: { type: "session_ready" }, tMs: 1000 }]);
  assert.equal(out[0].delayMs, 0);
  assert.equal(out[0].origDelayMs, 0);
});

test("gaps under the cap pass through uncapped", () => {
  const out = computePacing([
    { frame: { type: "session_ready" }, tMs: 0 },
    { frame: { type: "done" }, tMs: 300 },
  ]);
  assert.equal(out[1].delayMs, 300);
  assert.equal(out[1].origDelayMs, 300);
});

test("gaps over 1500ms are capped in delayMs but preserved in origDelayMs", () => {
  const out = computePacing([
    { frame: { type: "session_ready" }, tMs: 0 },
    { frame: { type: "done" }, tMs: 9000 },
  ]);
  assert.equal(out[1].delayMs, 1500);
  assert.equal(out[1].origDelayMs, 9000);
});

test("delayMs is never negative even with out-of-order timestamps", () => {
  const out = computePacing([
    { frame: { type: "session_ready" }, tMs: 1000 },
    { frame: { type: "done" }, tMs: 500 },
  ]);
  assert.equal(out[1].delayMs, 0);
  assert.equal(out[1].origDelayMs, 0);
});

test("preserves frame content and order", () => {
  const frames = [
    { type: "session_ready" },
    { type: "text", payload: { delta: "hi" } },
    { type: "done" },
  ];
  const out = computePacing(frames.map((frame, i) => ({ frame, tMs: i * 100 })));
  assert.deepEqual(out.map((e) => e.frame), frames);
});
