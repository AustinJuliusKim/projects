import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClientMsg,
  ServerMsg,
  Mode,
  isMode,
  parseClientMessage,
  serverMessage,
} from "./index.js";

test("parseClientMessage accepts valid frames", () => {
  assert.deepEqual(parseClientMessage('{"type":"setKey","key":"sk-abc"}'), {
    type: ClientMsg.SET_KEY,
    key: "sk-abc",
  });
  assert.deepEqual(parseClientMessage({ type: "prompt", text: "hi" }), {
    type: ClientMsg.PROMPT,
    text: "hi",
  });
  assert.equal(parseClientMessage({ type: "interrupt" }).type, ClientMsg.INTERRUPT);
});

test("parseClientMessage rejects malformed frames", () => {
  assert.throws(() => parseClientMessage("not json"), /invalid JSON/);
  assert.throws(() => parseClientMessage({ type: "nope" }), /unknown client message/);
  assert.throws(() => parseClientMessage({ type: "setKey", key: "" }), /non-empty key/);
  assert.throws(() => parseClientMessage({ type: "prompt", text: "  " }), /non-empty text/);
  assert.throws(() => parseClientMessage({ type: "setMode", mode: "wild" }), /invalid mode/);
  assert.throws(() => parseClientMessage({ type: "approve" }), /requires an id/);
});

test("isMode maps the three UI modes", () => {
  assert.ok(isMode(Mode.PLAN));
  assert.ok(isMode(Mode.ACCEPT_EDITS));
  assert.ok(isMode(Mode.AUTO));
  assert.ok(!isMode("default"));
});

test("serverMessage builds validated frames", () => {
  assert.equal(serverMessage(ServerMsg.DONE), '{"type":"done"}');
  assert.equal(
    serverMessage(ServerMsg.TEXT, { delta: "hello" }),
    '{"type":"text","delta":"hello"}',
  );
  assert.throws(() => serverMessage("bogus"), /unknown server message/);
});
