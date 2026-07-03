import test from "node:test";
import assert from "node:assert/strict";

import { applyAuthorGate, applyMultiPlanGate } from "../src/authorGate.js";
import { isServerFrame } from "@guided-repl/protocol";

const planEvents = [
  { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
  {
    frame: {
      type: "tool_use",
      payload: { id: "1", tool: "Write", input: { file_path: "~/.claude/plans/plan.md", content: "# Plan\n\n1. Do the thing" } },
    },
    delayMs: 100,
    origDelayMs: 100,
  },
  {
    frame: { type: "usage", payload: { inputTokens: 10, outputTokens: 5 } },
    delayMs: 20,
    origDelayMs: 20,
  },
  { frame: { type: "done" }, delayMs: 50, origDelayMs: 50 },
];

const executionEvents = [
  { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
  { frame: { type: "tool_use", payload: { id: "2", tool: "Write", input: {} } }, delayMs: 100, origDelayMs: 100 },
  {
    frame: { type: "usage", payload: { inputTokens: 20, outputTokens: 15 } },
    delayMs: 20,
    origDelayMs: 20,
  },
  { frame: { type: "done" }, delayMs: 50, origDelayMs: 50 },
];

test("marker is inserted between plan and execution events", () => {
  const out = applyAuthorGate(planEvents, executionEvents);
  const gateIdx = out.findIndex((e) => "awaitClient" in e);
  assert.deepEqual(out[gateIdx], { awaitClient: "permission", choices: ["approve", "deny"] });
});

test("duplicate session_ready from the execution tail is dropped", () => {
  const out = applyAuthorGate(planEvents, executionEvents);
  const sessionReadyCount = out.filter(
    (e) => "frame" in e && e.frame.type === "session_ready"
  ).length;
  assert.equal(sessionReadyCount, 1);
});

test("plan segment's terminal usage and done frames are dropped; only the execution tail's remain", () => {
  const out = applyAuthorGate(planEvents, executionEvents);
  const doneCount = out.filter((e) => "frame" in e && e.frame.type === "done").length;
  const usageCount = out.filter((e) => "frame" in e && e.frame.type === "usage").length;
  assert.equal(doneCount, 1);
  assert.equal(usageCount, 1);
  assert.equal(out[out.length - 1].frame.type, "done");
});

test("a permission_request frame is synthesized immediately before the awaitClient marker", () => {
  const out = applyAuthorGate(planEvents, executionEvents);
  const gateIdx = out.findIndex((e) => "awaitClient" in e);
  const prevEvent = out[gateIdx - 1];
  assert.ok("frame" in prevEvent);
  assert.equal(prevEvent.frame.type, "permission_request");
  assert.equal(prevEvent.frame.payload.tool, "ExitPlanMode");
  assert.match(prevEvent.frame.payload.input.plan, /Do the thing/);
});

test("the synthesized permission_request frame is a well-formed ServerFrame", () => {
  const out = applyAuthorGate(planEvents, executionEvents);
  const gateIdx = out.findIndex((e) => "awaitClient" in e);
  const permissionRequestFrame = out[gateIdx - 1].frame;
  assert.equal(isServerFrame(permissionRequestFrame), true);
});

test("all non-terminal plan events precede the permission_request, all non-init execution events follow the gate", () => {
  const out = applyAuthorGate(planEvents, executionEvents);
  const gateIdx = out.findIndex((e) => "awaitClient" in e);
  const expectedPlanBody = planEvents.filter(
    (e) => e.frame.type !== "usage" && e.frame.type !== "done"
  );
  assert.deepEqual(out.slice(0, gateIdx - 1), expectedPlanBody);
  assert.deepEqual(
    out.slice(gateIdx + 1),
    executionEvents.filter((e) => e.frame.type !== "session_ready")
  );
});

// --- applyMultiPlanGate (3-segment revise -> approve -> exec case) ---

const planV1Events = [
  { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
  {
    frame: { type: "tool_use", payload: { id: "1", tool: "Write", input: { file_path: "~/.claude/plans/plan.md", content: "# Plan v1\n\n1. Do the thing" } } },
    delayMs: 100,
    origDelayMs: 100,
  },
  { frame: { type: "usage", payload: { inputTokens: 10, outputTokens: 5 } }, delayMs: 20, origDelayMs: 20 },
  { frame: { type: "done" }, delayMs: 50, origDelayMs: 50 },
];

const planV2Events = [
  { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
  {
    frame: { type: "tool_use", payload: { id: "2", tool: "Write", input: { file_path: "~/.claude/plans/plan.md", content: "# Plan v2\n\n1. Do the revised thing" } } },
    delayMs: 100,
    origDelayMs: 100,
  },
  { frame: { type: "usage", payload: { inputTokens: 12, outputTokens: 6 } }, delayMs: 20, origDelayMs: 20 },
  { frame: { type: "done" }, delayMs: 50, origDelayMs: 50 },
];

const execSegmentEvents = [
  { frame: { type: "session_ready" }, delayMs: 0, origDelayMs: 0 },
  { frame: { type: "tool_use", payload: { id: "3", tool: "Write", input: {} } }, delayMs: 100, origDelayMs: 100 },
  { frame: { type: "usage", payload: { inputTokens: 20, outputTokens: 15 } }, delayMs: 20, origDelayMs: 20 },
  { frame: { type: "done" }, delayMs: 50, origDelayMs: 50 },
];

test("multiPlanGate: requires at least 2 segments", () => {
  assert.throws(() => applyMultiPlanGate([planV1Events], []));
});

test("multiPlanGate: requires exactly segments.length - 1 gate choice lists", () => {
  assert.throws(() => applyMultiPlanGate([planV1Events, planV2Events, execSegmentEvents], [["approve", "deny"]]));
});

test("multiPlanGate: inserts one gate per segment boundary, in order", () => {
  const out = applyMultiPlanGate(
    [planV1Events, planV2Events, execSegmentEvents],
    [
      ["revise", "approve"],
      ["approve", "deny"],
    ]
  );
  const gates = out.filter((e) => "awaitClient" in e);
  assert.equal(gates.length, 2);
  assert.deepEqual(gates[0].choices, ["revise", "approve"]);
  assert.deepEqual(gates[1].choices, ["approve", "deny"]);
});

test("multiPlanGate: only the first segment's session_ready survives", () => {
  const out = applyMultiPlanGate(
    [planV1Events, planV2Events, execSegmentEvents],
    [
      ["revise", "approve"],
      ["approve", "deny"],
    ]
  );
  const sessionReadyCount = out.filter((e) => "frame" in e && e.frame.type === "session_ready").length;
  assert.equal(sessionReadyCount, 1);
});

test("multiPlanGate: only the last segment's terminal usage/done survive, and the fixture ends on done", () => {
  const out = applyMultiPlanGate(
    [planV1Events, planV2Events, execSegmentEvents],
    [
      ["revise", "approve"],
      ["approve", "deny"],
    ]
  );
  const doneCount = out.filter((e) => "frame" in e && e.frame.type === "done").length;
  const usageCount = out.filter((e) => "frame" in e && e.frame.type === "usage").length;
  assert.equal(doneCount, 1);
  assert.equal(usageCount, 1);
  assert.equal(out[out.length - 1].frame.type, "done");
});

test("multiPlanGate: each synthesized permission_request excerpts the plan text of the segment that precedes it", () => {
  const out = applyMultiPlanGate(
    [planV1Events, planV2Events, execSegmentEvents],
    [
      ["revise", "approve"],
      ["approve", "deny"],
    ]
  );
  const gateIdxs = out.map((e, i) => ("awaitClient" in e ? i : -1)).filter((i) => i >= 0);
  assert.equal(gateIdxs.length, 2);
  assert.match(out[gateIdxs[0] - 1].frame.payload.input.plan, /Do the thing/);
  assert.match(out[gateIdxs[1] - 1].frame.payload.input.plan, /Do the revised thing/);
});

test("multiPlanGate: every synthesized permission_request frame is a well-formed ServerFrame", () => {
  const out = applyMultiPlanGate(
    [planV1Events, planV2Events, execSegmentEvents],
    [
      ["revise", "approve"],
      ["approve", "deny"],
    ]
  );
  for (const e of out) {
    if ("frame" in e) assert.ok(isServerFrame(e.frame));
  }
});

test("multiPlanGate with 2 segments matches applyAuthorGate's output shape", () => {
  const viaAuthorGate = applyAuthorGate(planV1Events, execSegmentEvents);
  const viaMultiPlan = applyMultiPlanGate([planV1Events, execSegmentEvents], [["approve", "deny"]]);
  assert.deepEqual(viaMultiPlan, viaAuthorGate);
});
