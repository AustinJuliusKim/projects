import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEvent } from "./streamMapper.mjs";
import { ServerMsg } from "@me/claude-repl-protocol";

test("init event yields session_ready with sessionId", () => {
  const out = mapEvent({ type: "system", subtype: "init", session_id: "abc" });
  assert.deepEqual(out, [{ type: ServerMsg.SESSION_READY, sessionId: "abc" }]);
});

test("assistant text + tool_use map to messages", () => {
  const out = mapEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.js" } },
      ],
    },
  });
  assert.deepEqual(out, [
    { type: ServerMsg.TEXT, delta: "hi" },
    { type: ServerMsg.TOOL_USE, id: "t1", tool: "Write", input: { file_path: "a.js" } },
  ]);
});

test("tool_result flattens array content and error flag", () => {
  const out = mapEvent({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "done" }], is_error: false },
      ],
    },
  });
  assert.deepEqual(out, [
    { type: ServerMsg.TOOL_RESULT, id: "t1", content: "done", isError: false },
  ]);
});

test("result event yields usage then done", () => {
  const out = mapEvent({
    type: "result",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    type: ServerMsg.USAGE,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    costUsd: 0.0123,
  });
  assert.deepEqual(out[1], { type: ServerMsg.DONE });
});

test("partial text_delta streams incremental text", () => {
  const out = mapEvent({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
  });
  assert.deepEqual(out, [{ type: ServerMsg.TEXT, delta: "lo" }]);
});

test("unknown / malformed events map to nothing", () => {
  assert.deepEqual(mapEvent(null), []);
  assert.deepEqual(mapEvent({ type: "mystery" }), []);
  assert.deepEqual(mapEvent({ type: "assistant", message: {} }), []);
});
