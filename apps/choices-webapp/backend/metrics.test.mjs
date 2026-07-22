import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emitCount,
  emitBusinessCount,
  setCanaryRequest,
  isCanaryRequest,
} from "./metrics.mjs";

// EMF lines go to console.log; capture them.
function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test("emitBusinessCount emits a ChoicesApp EMF line normally", () => {
  setCanaryRequest(false);
  const lines = capture(() => emitBusinessCount("GameCreated"));
  assert.equal(lines.length, 1);
  const doc = JSON.parse(lines[0]);
  assert.equal(doc.GameCreated, 1);
  assert.equal(doc._aws.CloudWatchMetrics[0].Namespace, "ChoicesApp");
});

test("canary requests suppress business counters but not operational ones", () => {
  setCanaryRequest(true);
  try {
    assert.equal(isCanaryRequest(), true);
    assert.equal(capture(() => emitBusinessCount("GameCompleted")).length, 0);
    // Latency/ApiError-style emits keep counting canary traffic.
    assert.equal(capture(() => emitCount("ApiError", { action: "x" })).length, 1);
  } finally {
    setCanaryRequest(false);
  }
});
