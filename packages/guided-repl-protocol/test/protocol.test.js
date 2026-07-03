import test from "node:test";
import assert from "node:assert/strict";

import { isServerFrame, SERVER_TYPES } from "../frames.js";
import { parseClientMessage, Mode } from "../clientMessages.js";
import { validateFixture, validateSnapshot } from "../fixtureFormat.js";
import { validateAssertion } from "../assertions.js";

test("parseClientMessage accepts a prompt message", () => {
  const msg = parseClientMessage({ type: "prompt", text: "make a page" });
  assert.deepEqual(msg, { type: "prompt", text: "make a page" });
});

test("parseClientMessage accepts a prompt message as JSON string", () => {
  const msg = parseClientMessage(JSON.stringify({ type: "prompt", text: "hi" }));
  assert.deepEqual(msg, { type: "prompt", text: "hi" });
});

test("parseClientMessage accepts permission approve/deny", () => {
  assert.deepEqual(parseClientMessage({ type: "permission", decision: "approve" }), {
    type: "permission",
    decision: "approve",
  });
  assert.deepEqual(parseClientMessage({ type: "permission", decision: "deny" }), {
    type: "permission",
    decision: "deny",
  });
});

test("parseClientMessage accepts interrupt", () => {
  assert.deepEqual(parseClientMessage({ type: "interrupt" }), { type: "interrupt" });
});

test("parseClientMessage rejects invalid JSON string", () => {
  assert.throws(() => parseClientMessage("{not json"));
});

test("parseClientMessage rejects non-object", () => {
  assert.throws(() => parseClientMessage("null"));
  assert.throws(() => parseClientMessage(42));
  assert.throws(() => parseClientMessage([1, 2]));
});

test("parseClientMessage rejects unknown type", () => {
  assert.throws(() => parseClientMessage({ type: "hack" }));
});

test("parseClientMessage rejects empty prompt text", () => {
  assert.throws(() => parseClientMessage({ type: "prompt", text: "" }));
  assert.throws(() => parseClientMessage({ type: "prompt", text: 5 }));
});

test("parseClientMessage rejects bad permission decision", () => {
  assert.throws(() => parseClientMessage({ type: "permission", decision: "maybe" }));
});

test("Mode enum is frozen and only exposes guided/byok/wallet", () => {
  assert.equal(Mode.GUIDED, "guided");
  assert.equal(Mode.BYOK, "byok");
  assert.equal(Mode.WALLET, "wallet");
  assert.throws(() => {
    Mode.GUIDED = "x";
  }, TypeError);
});

test("isServerFrame accepts all known frame types", () => {
  assert.ok(isServerFrame({ type: "session_ready" }));
  assert.ok(isServerFrame({ type: "text", payload: { delta: "hi" } }));
  assert.ok(isServerFrame({ type: "tool_use", payload: { id: "1", tool: "Bash", input: {} } }));
  assert.ok(isServerFrame({ type: "tool_result", payload: { id: "1", content: "ok", isError: false } }));
  assert.ok(
    isServerFrame({ type: "permission_request", payload: { id: "1", tool: "Bash", input: {} } })
  );
  assert.ok(
    isServerFrame({ type: "usage", payload: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 } })
  );
  assert.ok(isServerFrame({ type: "file_tree", payload: { tree: {} } }));
  assert.ok(isServerFrame({ type: "file_content", payload: { path: "a.txt", content: "x" } }));
  assert.ok(isServerFrame({ type: "done" }));
  assert.ok(isServerFrame({ type: "error", payload: { message: "oops", code: "E1" } }));
  assert.equal(SERVER_TYPES.size, 10);
});

test("isServerFrame accepts a usage frame without costUsd", () => {
  assert.ok(isServerFrame({ type: "usage", payload: { inputTokens: 1, outputTokens: 2 } }));
});

test("isServerFrame rejects malformed frames", () => {
  assert.equal(isServerFrame(null), false);
  assert.equal(isServerFrame("text"), false);
  assert.equal(isServerFrame({ type: "not_a_type" }), false);
  assert.equal(isServerFrame({ type: "text" }), false);
  assert.equal(isServerFrame({ type: "text", payload: { delta: 5 } }), false);
  assert.equal(isServerFrame({ type: "usage", payload: { inputTokens: 1, outputTokens: "2" } }), false);
});

test("validateFixture accepts a well-formed fixture", () => {
  const fixture = {
    fixtureVersion: 1,
    claudeCodeVersion: "2.1.198",
    lessonId: "l1",
    branchId: "vague",
    recordedAt: "2026-07-02T00:00:00Z",
    seedSnapshotId: "l1-input",
    permissionMode: "acceptEdits",
    expectedPrompt: "make a page about me",
    events: [
      { frame: { type: "session_ready" }, delayMs: 0 },
      { frame: { type: "text", payload: { delta: "Sure" } }, delayMs: 100, origDelayMs: 250 },
      { awaitClient: "permission", choices: ["approve", "deny"] },
      { frame: { type: "done" }, delayMs: 50 },
    ],
    assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
  };
  assert.doesNotThrow(() => validateFixture(fixture));
});

test("validateFixture rejects non-object", () => {
  assert.throws(() => validateFixture(null));
  assert.throws(() => validateFixture("nope"));
});

test("validateFixture rejects wrong fixtureVersion", () => {
  assert.throws(() => validateFixture({ fixtureVersion: 2 }));
});

test("validateFixture rejects missing string fields", () => {
  assert.throws(() =>
    validateFixture({
      fixtureVersion: 1,
      claudeCodeVersion: "2.1.198",
      lessonId: "l1",
      branchId: "vague",
      recordedAt: "2026-07-02T00:00:00Z",
      seedSnapshotId: "l1-input",
      permissionMode: "acceptEdits",
      // expectedPrompt missing
      events: [],
      assertion: { type: "file-exists", path: "index.html" },
    })
  );
});

test("validateFixture rejects events that are not arrays", () => {
  assert.throws(() =>
    validateFixture({
      fixtureVersion: 1,
      claudeCodeVersion: "2.1.198",
      lessonId: "l1",
      branchId: "vague",
      recordedAt: "2026-07-02T00:00:00Z",
      seedSnapshotId: "l1-input",
      permissionMode: "acceptEdits",
      expectedPrompt: "make a page about me",
      events: "not-an-array",
      assertion: { type: "file-exists", path: "index.html" },
    })
  );
});

test("validateFixture rejects a bad frame inside events", () => {
  assert.throws(() =>
    validateFixture({
      fixtureVersion: 1,
      claudeCodeVersion: "2.1.198",
      lessonId: "l1",
      branchId: "vague",
      recordedAt: "2026-07-02T00:00:00Z",
      seedSnapshotId: "l1-input",
      permissionMode: "acceptEdits",
      expectedPrompt: "make a page about me",
      events: [{ frame: { type: "text", payload: {} }, delayMs: 10 }],
      assertion: { type: "file-exists", path: "index.html" },
    })
  );
});

test("validateFixture rejects a malformed awaitClient marker", () => {
  assert.throws(() =>
    validateFixture({
      fixtureVersion: 1,
      claudeCodeVersion: "2.1.198",
      lessonId: "l1",
      branchId: "plan-mode",
      recordedAt: "2026-07-02T00:00:00Z",
      seedSnapshotId: "l1-input",
      permissionMode: "plan",
      expectedPrompt: "make a personal landing page for my photography, single HTML file, inline CSS",
      events: [{ awaitClient: "wrong", choices: ["approve"] }],
      assertion: { type: "file-exists", path: "index.html" },
    })
  );
});

test("validateFixture rejects an invalid assertion", () => {
  assert.throws(() =>
    validateFixture({
      fixtureVersion: 1,
      claudeCodeVersion: "2.1.198",
      lessonId: "l1",
      branchId: "vague",
      recordedAt: "2026-07-02T00:00:00Z",
      seedSnapshotId: "l1-input",
      permissionMode: "acceptEdits",
      expectedPrompt: "make a page about me",
      events: [],
      assertion: { type: "unknown-type" },
    })
  );
});

test("validateSnapshot accepts a well-formed snapshot", () => {
  assert.doesNotThrow(() =>
    validateSnapshot({
      snapshotId: "l1-input",
      files: [{ path: "README.md", content: "# hi" }],
    })
  );
});

test("validateSnapshot rejects a leading-slash path", () => {
  assert.throws(() =>
    validateSnapshot({
      snapshotId: "l1-input",
      files: [{ path: "/README.md", content: "# hi" }],
    })
  );
});

test("validateSnapshot rejects non-array files", () => {
  assert.throws(() => validateSnapshot({ snapshotId: "x", files: "nope" }));
});

test("validateAssertion accepts the 4 known types", () => {
  assert.doesNotThrow(() => validateAssertion({ type: "file-contains", path: "a", match: "b" }));
  assert.doesNotThrow(() => validateAssertion({ type: "file-exists", path: "a" }));
  assert.doesNotThrow(() => validateAssertion({ type: "terminal-matches", match: "b" }));
  assert.doesNotThrow(() => validateAssertion({ type: "file-equals", path: "a", content: "b" }));
});

test("validateAssertion rejects unknown type and missing fields", () => {
  assert.throws(() => validateAssertion({ type: "file-contains", path: "a" }));
  assert.throws(() => validateAssertion({ type: "nope" }));
  assert.throws(() => validateAssertion(null));
});

test("validateAssertion accepts a well-formed quiz assertion", () => {
  assert.doesNotThrow(() =>
    validateAssertion({
      type: "quiz",
      question: "Which step explored the codebase first?",
      choices: ["Explore", "Plan", "Execute"],
      correctIndex: 0,
    })
  );
});

test("validateAssertion rejects a quiz with an out-of-range correctIndex", () => {
  assert.throws(() =>
    validateAssertion({
      type: "quiz",
      question: "Which step explored the codebase first?",
      choices: ["Explore", "Plan"],
      correctIndex: 2,
    })
  );
  assert.throws(() =>
    validateAssertion({
      type: "quiz",
      question: "Which step explored the codebase first?",
      choices: ["Explore", "Plan"],
      correctIndex: -1,
    })
  );
});

test("validateAssertion rejects a quiz with fewer than 2 choices", () => {
  assert.throws(() =>
    validateAssertion({
      type: "quiz",
      question: "Which step explored the codebase first?",
      choices: ["Explore"],
      correctIndex: 0,
    })
  );
});

test("validateAssertion rejects a quiz with a non-string choice", () => {
  assert.throws(() =>
    validateAssertion({
      type: "quiz",
      question: "Which step explored the codebase first?",
      choices: ["Explore", 5],
      correctIndex: 0,
    })
  );
});

test("parseClientMessage accepts next", () => {
  assert.deepEqual(parseClientMessage({ type: "next" }), { type: "next" });
});

test("isServerFrame accepts a usage frame with model", () => {
  assert.ok(
    isServerFrame({ type: "usage", payload: { inputTokens: 1, outputTokens: 2, model: "claude-haiku" } })
  );
});

test("isServerFrame rejects a usage frame with a non-string model", () => {
  assert.equal(
    isServerFrame({ type: "usage", payload: { inputTokens: 1, outputTokens: 2, model: 5 } }),
    false
  );
});

test("validateFixture accepts a frame event with an annotation", () => {
  const fixture = {
    fixtureVersion: 1,
    claudeCodeVersion: "2.1.198",
    lessonId: "l2",
    branchId: "walkthrough",
    recordedAt: "2026-07-02T00:00:00Z",
    seedSnapshotId: "l1-output",
    permissionMode: "acceptEdits",
    expectedPrompt: "make a page about me",
    events: [
      {
        frame: { type: "text", payload: { delta: "Exploring…" } },
        delayMs: 0,
        annotation: { title: "Explore", body: "Claude reads the codebase before making changes." },
      },
    ],
    assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
  };
  assert.doesNotThrow(() => validateFixture(fixture));
});

test("validateFixture rejects a malformed annotation", () => {
  const base = {
    fixtureVersion: 1,
    claudeCodeVersion: "2.1.198",
    lessonId: "l2",
    branchId: "walkthrough",
    recordedAt: "2026-07-02T00:00:00Z",
    seedSnapshotId: "l1-output",
    permissionMode: "acceptEdits",
    expectedPrompt: "make a page about me",
    assertion: { type: "file-exists", path: "index.html" },
  };
  assert.throws(() =>
    validateFixture({
      ...base,
      events: [{ frame: { type: "text", payload: { delta: "hi" } }, delayMs: 0, annotation: { title: "Explore" } }],
    })
  );
  assert.throws(() =>
    validateFixture({
      ...base,
      events: [{ frame: { type: "text", payload: { delta: "hi" } }, delayMs: 0, annotation: "not-an-object" }],
    })
  );
});
