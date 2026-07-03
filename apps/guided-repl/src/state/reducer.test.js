import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer, createInitialState } from "./reducer.js";

test("session_ready sets status running", () => {
  const state = reducer(createInitialState(), { type: "session_ready" });
  assert.equal(state.status, "running");
});

test("text frames fold consecutive deltas into the trailing assistant message", () => {
  let state = createInitialState();
  state = reducer(state, { type: "text", payload: { delta: "Hel" } });
  state = reducer(state, { type: "text", payload: { delta: "lo" } });
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0], { role: "assistant", text: "Hello" });
});

test("tool_use appends a tool message and applies optimistic FS", () => {
  let state = createInitialState();
  state = reducer(state, {
    type: "tool_use",
    payload: { id: "t1", tool: "Write", input: { file_path: "index.html", content: "<h1>hi</h1>" } },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].role, "tool");
  assert.equal(state.messages[0].id, "t1");
  assert.equal(state.files["index.html"].content, "<h1>hi</h1>");
});

test("tool_result attaches result by id", () => {
  let state = createInitialState();
  state = reducer(state, {
    type: "tool_use",
    payload: { id: "t1", tool: "Write", input: { file_path: "a.txt", content: "x" } },
  });
  state = reducer(state, { type: "tool_result", payload: { id: "t1", content: "ok", isError: false } });
  assert.deepEqual(state.messages[0].result, { content: "ok", isError: false });
});

test("permission_request sets status and permission", () => {
  const state = reducer(createInitialState(), {
    type: "permission_request",
    payload: { id: "p1", tool: "Write", input: {} },
  });
  assert.equal(state.status, "awaiting_permission");
  assert.deepEqual(state.permission, { id: "p1", tool: "Write", input: {} });
});

test("file_tree merges via virtualFs.mergeTree", () => {
  const state = reducer(createInitialState(), {
    type: "file_tree",
    payload: { tree: { tree: [{ path: "README.md", type: "file" }] } },
  });
  assert.equal(state.files["README.md"].content, "");
});

test("file_content sets file content", () => {
  const state = reducer(createInitialState(), {
    type: "file_content",
    payload: { path: "README.md", content: "hello" },
  });
  assert.equal(state.files["README.md"].content, "hello");
});

test("usage sets usage", () => {
  const usage = { inputTokens: 1, outputTokens: 2, costUsd: 0.01 };
  const state = reducer(createInitialState(), { type: "usage", payload: usage });
  assert.deepEqual(state.usage, usage);
});

test("done sets status done", () => {
  const state = reducer(createInitialState(), { type: "done" });
  assert.equal(state.status, "done");
});

test("error appends an error message", () => {
  const state = reducer(createInitialState(), {
    type: "error",
    payload: { message: "boom", code: "E1" },
  });
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0], { role: "error", message: "boom", code: "E1" });
});

test("prompt_sent appends a user message and clears hint", () => {
  let state = createInitialState();
  state = { ...state, hint: { kind: "hint", text: "old" } };
  state = reducer(state, { type: "prompt_sent", text: "make a page" });
  assert.deepEqual(state.messages[0], { role: "user", text: "make a page" });
  assert.equal(state.hint, null);
});

test("annotation_shown sets state.annotation", () => {
  const annotation = { title: "Explore", body: "Reads the codebase first." };
  const state = reducer(createInitialState(), { type: "annotation_shown", annotation });
  assert.deepEqual(state.annotation, annotation);
});

test("annotation_cleared clears state.annotation", () => {
  let state = createInitialState();
  state = reducer(state, { type: "annotation_shown", annotation: { title: "Explore", body: "x" } });
  state = reducer(state, { type: "annotation_cleared" });
  assert.equal(state.annotation, null);
});

test("reset returns the initial state", () => {
  let state = reducer(createInitialState(), { type: "session_ready" });
  state = reducer(state, { type: "reset" });
  assert.deepEqual(state, createInitialState());
});
