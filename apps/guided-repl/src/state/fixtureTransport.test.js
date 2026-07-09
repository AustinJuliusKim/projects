import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureTransport } from "./fixtureTransport.js";

const snapshot = { snapshotId: "s1", files: [{ path: "README.md", content: "hello" }] };

function makeFixture(branchId, expectedPrompt, events) {
  return {
    fixtureVersion: 1,
    claudeCodeVersion: "1.0.0",
    lessonId: "l5",
    branchId,
    recordedAt: "2026-01-01T00:00:00Z",
    seedSnapshotId: "s1",
    permissionMode: "plan",
    expectedPrompt,
    events,
    assertion: { type: "file-exists", path: "index.html" },
  };
}

const sharedPrompt = "rewrite the projects section, keep it one file";
const doneEvent = { frame: { type: "done" }, delayMs: 0 };

/** Two branches sharing an expectedPrompt — the l4/l5/l7/l8 shape. */
function makeBranches() {
  return [
    {
      branchId: "plan",
      expectedPrompt: sharedPrompt,
      fixture: makeFixture("plan", sharedPrompt, [
        { frame: { type: "text", payload: { delta: "plan branch" } }, delayMs: 0 },
        doneEvent,
      ]),
    },
    {
      branchId: "acceptEdits",
      expectedPrompt: sharedPrompt,
      fixture: makeFixture("acceptEdits", sharedPrompt, [
        { frame: { type: "text", payload: { delta: "acceptEdits branch" } }, delayMs: 0 },
        doneEvent,
      ]),
    },
  ];
}

/** Collects frames until a done frame arrives. */
function connectAndCollect(transport) {
  const frames = [];
  const done = new Promise((resolve) => {
    transport.connect({
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.type === "done") resolve();
      },
      onStatus: () => {},
    });
  });
  return { frames, done };
}

test("explicit branchId selects a non-first branch sharing the same prompt", async () => {
  const transport = fixtureTransport({ branches: makeBranches(), snapshot, speedMultiplier: 0 });
  const { frames, done } = connectAndCollect(transport);

  transport.send({ type: "prompt", text: sharedPrompt, branchId: "acceptEdits" });
  await done;

  assert.ok(frames.some((f) => f.type === "text" && f.payload.delta === "acceptEdits branch"));
  assert.ok(!frames.some((f) => f.type === "text" && f.payload.delta === "plan branch"));
});

test("without a branchId, prompt matching falls back to the first match", async () => {
  const transport = fixtureTransport({ branches: makeBranches(), snapshot, speedMultiplier: 0 });
  const { frames, done } = connectAndCollect(transport);

  transport.send({ type: "prompt", text: sharedPrompt });
  await done;

  assert.ok(frames.some((f) => f.type === "text" && f.payload.delta === "plan branch"));
});

test("unknown branchId raises the hint path instead of playing", () => {
  const transport = fixtureTransport({ branches: makeBranches(), snapshot, speedMultiplier: 0 });
  const statuses = [];
  transport.connect({ onFrame: () => {}, onStatus: (s) => statuses.push(s) });

  transport.send({ type: "prompt", text: "whatever", branchId: "nope" });
  assert.ok(statuses.some((s) => s.kind === "hint"));
});

test("drill pseudo-branch plays a shellTranscript fixture via explicit branchId", async () => {
  const drillFixture = {
    fixtureVersion: 1,
    kind: "shellTranscript",
    claudeCodeVersion: "1.0.0",
    lessonId: "l6",
    branchId: "drill",
    recordedAt: "2026-01-01T00:00:00Z",
    seedSnapshotId: "s1",
    events: [{ frame: { type: "tty_chunk", payload: { data: "$ git diff\n" } }, delayMs: 0 }, doneEvent],
  };
  const branches = [
    ...makeBranches(),
    { branchId: "drill:try-git", expectedPrompt: null, fixture: drillFixture },
  ];
  const transport = fixtureTransport({ branches, snapshot, speedMultiplier: 0 });
  const { frames, done } = connectAndCollect(transport);

  transport.send({ type: "prompt", text: "git diff", branchId: "drill:try-git" });
  await done;

  assert.ok(frames.some((f) => f.type === "tty_chunk" && f.payload.data === "$ git diff\n"));
});

test("anchored annotations reach the player for the selected branch only", async () => {
  const statuses = [];
  const transport = fixtureTransport({
    branches: makeBranches(),
    snapshot,
    speedMultiplier: 0,
    annotations: { plan: { 0: { body: "anchored" } } },
  });
  const done = new Promise((resolve) => {
    transport.connect({
      onFrame: (f) => f.type === "done" && resolve(),
      onStatus: (s) => statuses.push(s),
    });
  });

  transport.send({ type: "prompt", text: sharedPrompt, branchId: "plan" });
  await done;

  const annotations = statuses.filter((s) => s.kind === "annotation");
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].annotation.body, "anchored");
});
