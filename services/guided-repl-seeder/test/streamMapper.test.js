import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isServerFrame } from "@guided-repl/protocol";
import { mapEvent } from "../src/streamMapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} name
 * @returns {object[]}
 */
function loadRaw(name) {
  const text = fs.readFileSync(path.join(__dirname, "fixtures", "raw", name), "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

for (const file of ["raw-acceptEdits.ndjson", "raw-plan.ndjson"]) {
  test(`every frame mapEvent emits from ${file} passes isServerFrame`, () => {
    const raws = loadRaw(file);
    for (const raw of raws) {
      const frames = mapEvent(raw);
      assert.ok(Array.isArray(frames));
      for (const frame of frames) {
        assert.ok(isServerFrame(frame), `bad frame from ${raw.type}: ${JSON.stringify(frame)}`);
      }
    }
  });
}

test("system/init maps to a single session_ready frame", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const init = raws.find((r) => r.type === "system" && r.subtype === "init");
  assert.deepEqual(mapEvent(init), [{ type: "session_ready" }]);
});

test("system/status maps to no frames", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const status = raws.find((r) => r.type === "system" && r.subtype !== "init");
  assert.deepEqual(mapEvent(status), []);
});

test("rate_limit_event maps to no frames", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const rle = raws.find((r) => r.type === "rate_limit_event");
  assert.deepEqual(mapEvent(rle), []);
});

test("stream_event text_delta maps to a text frame", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const textDelta = raws.find(
    (r) => r.type === "stream_event" && r.event?.delta?.type === "text_delta"
  );
  assert.deepEqual(mapEvent(textDelta), [
    { type: "text", payload: { delta: textDelta.event.delta.text } },
  ]);
});

test("stream_event message_start/stop/signature/input_json_delta map to no frames", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  for (const raw of raws) {
    if (raw.type !== "stream_event") continue;
    const et = raw.event?.type;
    const dt = raw.event?.delta?.type;
    if (et === "message_start" || et === "message_stop" || dt === "signature_delta" || dt === "input_json_delta") {
      assert.deepEqual(mapEvent(raw), []);
    }
  }
});

test("assistant tool_use block maps to a tool_use frame", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const withToolUse = raws.find(
    (r) => r.type === "assistant" && r.message.content.some((b) => b.type === "tool_use")
  );
  const block = withToolUse.message.content.find((b) => b.type === "tool_use");
  const frames = mapEvent(withToolUse);
  assert.deepEqual(frames, [
    { type: "tool_use", payload: { id: block.id, tool: block.name, input: block.input } },
  ]);
});

test("assistant text/thinking blocks are not mapped (text comes from stream_event deltas)", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const textOnly = raws.find(
    (r) =>
      r.type === "assistant" &&
      r.message.content.length > 0 &&
      r.message.content.every((b) => b.type !== "tool_use")
  );
  assert.deepEqual(mapEvent(textOnly), []);
});

test("user tool_result maps to a tool_result frame", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const userMsg = raws.find((r) => r.type === "user");
  const block = userMsg.message.content.find((b) => b.type === "tool_result");
  const frames = mapEvent(userMsg);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "tool_result");
  assert.equal(frames[0].payload.id, block.tool_use_id);
  assert.equal(frames[0].payload.isError, block.is_error === true);
});

test("result/success maps to usage + done frames (no costUsd)", () => {
  const raws = loadRaw("raw-acceptEdits.ndjson");
  const result = raws.find((r) => r.type === "result");
  assert.equal(result.subtype, "success");
  const frames = mapEvent(result);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], {
    type: "usage",
    payload: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
  });
  assert.equal("costUsd" in frames[0].payload, false);
  assert.deepEqual(frames[1], { type: "done" });
});

test("plan-mode probe: assistant Write tool_use to a plan file maps cleanly", () => {
  const raws = loadRaw("raw-plan.ndjson");
  const planWrite = raws.find(
    (r) =>
      r.type === "assistant" &&
      r.message.content.some((b) => b.type === "tool_use" && b.name === "Write")
  );
  const frames = mapEvent(planWrite);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "tool_use");
  assert.match(frames[0].payload.input.file_path, /\.claude\/plans\/.*\.md$/);
});

test("expected frame sequence around init -> tool_use -> result for the plan probe", () => {
  const raws = loadRaw("raw-plan.ndjson");
  const initIdx = raws.findIndex((r) => r.type === "system" && r.subtype === "init");
  const resultIdx = raws.findIndex((r) => r.type === "result");
  assert.ok(initIdx >= 0 && resultIdx > initIdx);
  assert.deepEqual(mapEvent(raws[initIdx]), [{ type: "session_ready" }]);
  const [usageFrame, doneFrame] = mapEvent(raws[resultIdx]);
  assert.equal(usageFrame.type, "usage");
  assert.equal(doneFrame.type, "done");
});
