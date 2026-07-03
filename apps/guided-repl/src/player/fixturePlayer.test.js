import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixturePlayer } from "./fixturePlayer.js";

const snapshot = { snapshotId: "s1", files: [{ path: "README.md", content: "hello" }] };

function makeFixture() {
  return {
    fixtureVersion: 1,
    claudeCodeVersion: "1.0.0",
    lessonId: "l1",
    branchId: "vague",
    recordedAt: "2026-01-01T00:00:00Z",
    seedSnapshotId: "l1-input",
    permissionMode: "acceptEdits",
    expectedPrompt: "make a page about me",
    events: [
      { frame: { type: "session_ready" }, delayMs: 0 },
      { frame: { type: "text", payload: { delta: "hi" } }, delayMs: 10 },
      { awaitClient: "permission", choices: ["approve", "deny"] },
      { frame: { type: "text", payload: { delta: " there" } }, delayMs: 10 },
      { frame: { type: "done" }, delayMs: 0 },
    ],
    assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
  };
}

test("fixturePlayer boots from snapshot, plays frames in order at speed 0, parks and resumes on awaitClient", async () => {
  const frames = [];
  const states = [];

  const player = createFixturePlayer({
    fixture: makeFixture(),
    snapshot,
    speedMultiplier: 0,
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => {
      states.push(s);
      if (s === "awaitingClient") {
        player.resolvePermission("approve");
      }
    },
  });

  await player.play();

  assert.equal(player.getState(), "done");
  assert.deepEqual(states, ["playing", "awaitingClient", "playing", "done"]);

  assert.equal(frames[0].type, "file_tree");
  assert.deepEqual(frames[0].payload.tree.tree, [{ path: "README.md", type: "file" }]);
  assert.deepEqual(frames[1], { type: "file_content", payload: { path: "README.md", content: "hello" } });
  assert.deepEqual(frames[2], { type: "session_ready" });
  assert.deepEqual(frames[3], { type: "text", payload: { delta: "hi" } });
  assert.deepEqual(frames[4], { type: "text", payload: { delta: " there" } });
  assert.deepEqual(frames[5], { type: "done" });
  assert.equal(frames.length, 6);
});

test("fixturePlayer interrupt() resets to idle and aborts in-flight playback", async () => {
  const frames = [];
  let player;

  player = createFixturePlayer({
    fixture: makeFixture(),
    snapshot,
    speedMultiplier: 0,
    onFrame: (f) => {
      frames.push(f);
      if (f.type === "session_ready") {
        player.interrupt();
      }
    },
    onStateChange: () => {},
  });

  await player.play();

  assert.equal(player.getState(), "idle");
  // session_ready was seen, but nothing after it (including "done") was emitted.
  assert.ok(frames.some((f) => f.type === "session_ready"));
  assert.ok(!frames.some((f) => f.type === "done"));
});

test("fixturePlayer is re-emittable after interrupt", async () => {
  let interruptedOnce = false;
  const doneFrames = [];
  let player;

  player = createFixturePlayer({
    fixture: makeFixture(),
    snapshot,
    speedMultiplier: 0,
    onFrame: (f) => {
      if (f.type === "session_ready" && !interruptedOnce) {
        interruptedOnce = true;
        player.interrupt();
      }
      if (f.type === "done") doneFrames.push(f);
    },
    onStateChange: (s) => {
      if (s === "awaitingClient") player.resolvePermission("approve");
    },
  });

  await player.play();
  assert.equal(player.getState(), "idle");

  await player.play();
  assert.equal(player.getState(), "done");
  assert.equal(doneFrames.length, 1);
});

function makeAnnotatedFixture() {
  return {
    fixtureVersion: 1,
    claudeCodeVersion: "1.0.0",
    lessonId: "l2",
    branchId: "walkthrough",
    recordedAt: "2026-01-01T00:00:00Z",
    seedSnapshotId: "l1-output",
    permissionMode: "acceptEdits",
    expectedPrompt: "make a page about me",
    events: [
      { frame: { type: "session_ready" }, delayMs: 0 },
      {
        frame: { type: "text", payload: { delta: "Exploring" } },
        delayMs: 0,
        annotation: { title: "Explore", body: "Reads the codebase first." },
      },
      { frame: { type: "text", payload: { delta: " Planning" } }, delayMs: 0 },
      { frame: { type: "done" }, delayMs: 0 },
    ],
    assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
  };
}

test("fixturePlayer with stepMode parks at annotated events and resumes on step()", async () => {
  const frames = [];
  const states = [];
  const statuses = [];
  let player;

  player = createFixturePlayer({
    fixture: makeAnnotatedFixture(),
    snapshot,
    speedMultiplier: 0,
    stepMode: true,
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => {
      states.push(s);
      if (s === "awaitingStep") {
        player.step();
      }
    },
    onStatus: (s) => statuses.push(s),
  });

  await player.play();

  assert.equal(player.getState(), "done");
  assert.ok(states.includes("awaitingStep"));
  assert.deepEqual(statuses, [{ kind: "annotation", annotation: { title: "Explore", body: "Reads the codebase first." } }]);
  // The annotated frame is emitted only after step() resumes playback.
  assert.ok(frames.some((f) => f.type === "text" && f.payload.delta === "Exploring"));
  assert.ok(frames.some((f) => f.type === "done"));
});

test("fixturePlayer with stepMode does not emit the annotated frame until step() resolves", async () => {
  const frames = [];
  let resolvedStep = null;
  let player;

  player = createFixturePlayer({
    fixture: makeAnnotatedFixture(),
    snapshot,
    speedMultiplier: 0,
    stepMode: true,
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => {
      if (s === "awaitingStep") {
        resolvedStep = false;
        // Delay the step to a later microtask to prove the annotated frame
        // hasn't been emitted yet.
        Promise.resolve().then(() => {
          assert.ok(!frames.some((f) => f.type === "text" && f.payload.delta === "Exploring"));
          resolvedStep = true;
          player.step();
        });
      }
    },
    onStatus: () => {},
  });

  await player.play();
  assert.equal(resolvedStep, true);
  assert.ok(frames.some((f) => f.type === "text" && f.payload.delta === "Exploring"));
});

test("fixturePlayer interrupt() wakes a parked step promise", async () => {
  const states = [];
  let player;

  player = createFixturePlayer({
    fixture: makeAnnotatedFixture(),
    snapshot,
    speedMultiplier: 0,
    stepMode: true,
    onFrame: () => {},
    onStateChange: (s) => {
      states.push(s);
      if (s === "awaitingStep") {
        player.interrupt();
      }
    },
    onStatus: () => {},
  });

  await player.play();

  assert.equal(player.getState(), "idle");
  assert.ok(states.includes("awaitingStep"));
  assert.ok(!states.includes("done"));
});

test("fixturePlayer with stepMode:false plays annotated events straight through", async () => {
  const frames = [];
  const states = [];
  const statuses = [];

  const player = createFixturePlayer({
    fixture: makeAnnotatedFixture(),
    snapshot,
    speedMultiplier: 0,
    stepMode: false,
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => states.push(s),
    onStatus: (s) => statuses.push(s),
  });

  await player.play();

  assert.equal(player.getState(), "done");
  assert.ok(!states.includes("awaitingStep"));
  assert.equal(statuses.length, 0);
  assert.ok(frames.some((f) => f.type === "text" && f.payload.delta === "Exploring"));
});
