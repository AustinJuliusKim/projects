import test from "node:test";
import assert from "node:assert/strict";

import { captureModelFromRaw, stampUsageModel } from "../src/modelStamp.js";

test("captureModelFromRaw returns the model id from a system/init event", () => {
  const raw = { type: "system", subtype: "init", model: "claude-sonnet-4-5-20250929" };
  assert.equal(captureModelFromRaw(raw), "claude-sonnet-4-5-20250929");
});

test("captureModelFromRaw returns undefined for non-init events", () => {
  assert.equal(captureModelFromRaw({ type: "assistant", message: { content: [] } }), undefined);
  assert.equal(captureModelFromRaw({ type: "system", subtype: "status" }), undefined);
});

test("captureModelFromRaw returns undefined when init carries no model field", () => {
  assert.equal(captureModelFromRaw({ type: "system", subtype: "init" }), undefined);
});

test("captureModelFromRaw is defensive against non-object input", () => {
  assert.equal(captureModelFromRaw(null), undefined);
  assert.equal(captureModelFromRaw(undefined), undefined);
});

test("stampUsageModel sets payload.model on usage frames only", () => {
  const events = [
    { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
    { frame: { type: "usage", payload: { inputTokens: 1, outputTokens: 2 } }, delayMs: 0, origDelayMs: 0 },
    { frame: { type: "done" }, delayMs: 0, origDelayMs: 0 },
  ];
  const out = stampUsageModel(events, "claude-haiku-4-5-20251001");
  assert.equal(out[0].frame.type, "session_ready");
  assert.equal("model" in out[0].frame, false);
  assert.equal(out[1].frame.payload.model, "claude-haiku-4-5-20251001");
  assert.equal(out[2].frame.type, "done");
});

test("stampUsageModel is a no-op when model is falsy", () => {
  const events = [{ frame: { type: "usage", payload: { inputTokens: 1, outputTokens: 2 } }, delayMs: 0, origDelayMs: 0 }];
  const out = stampUsageModel(events, undefined);
  assert.equal(out, events);
});

test("stampUsageModel does not mutate the input array", () => {
  const events = [{ frame: { type: "usage", payload: { inputTokens: 1, outputTokens: 2 } }, delayMs: 0, origDelayMs: 0 }];
  stampUsageModel(events, "claude-haiku-4-5-20251001");
  assert.equal("model" in events[0].frame.payload, false);
});

test("stampUsageModel preserves awaitClient markers unchanged", () => {
  const events = [{ awaitClient: "permission", choices: ["approve", "deny"] }];
  const out = stampUsageModel(events, "claude-haiku-4-5-20251001");
  assert.deepEqual(out[0], { awaitClient: "permission", choices: ["approve", "deny"] });
});
