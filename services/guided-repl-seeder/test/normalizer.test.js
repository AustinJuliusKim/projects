import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFrame } from "../src/normalizer.js";

const HOME = "/Users/aukim";
const CWD = "/private/tmp/claude-502/some-session/scratchpad/ws-accept";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * @param {unknown} obj
 * @returns {void}
 */
function assertNoLeaks(obj) {
  const s = JSON.stringify(obj);
  assert.doesNotMatch(s, /\/Users\//);
  assert.doesNotMatch(s, /\/private\/tmp/);
  assert.doesNotMatch(s, UUID_RE);
  assert.doesNotMatch(s, /sk-ant-/);
}

test("workspace-absolute file_path rewrites to workspace-relative", () => {
  const frame = {
    type: "tool_use",
    payload: { id: "1", tool: "Write", input: { file_path: `${CWD}/index.html`, content: "x" } },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assert.equal(out.payload.input.file_path, "index.html");
  assertNoLeaks(out);
});

test("home-but-outside-workspace path rewrites to ~/ and normalizes plan filename", () => {
  const frame = {
    type: "tool_use",
    payload: {
      id: "1",
      tool: "Write",
      input: {
        file_path: `${HOME}/.claude/plans/make-a-personal-landing-curious-lampson.md`,
        content: "# Plan",
      },
    },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assert.equal(out.payload.input.file_path, "~/.claude/plans/plan.md");
  assertNoLeaks(out);
});

test("uuids and key-shaped strings in tool_result content are redacted", () => {
  const frame = {
    type: "tool_result",
    payload: {
      id: "1",
      content: "session 4209af04-3b1b-4039-8b88-b5fa42bb2302 used key sk-ant-api03-abc123XYZ",
      isError: false,
    },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assertNoLeaks(out);
});

test("frames without a payload pass through unchanged", () => {
  const frame = { type: "session_ready" };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assert.deepEqual(out, frame);
});

test("leftover /Users or /private/tmp paths not under home/cwd are still redacted", () => {
  const frame = {
    type: "tool_result",
    payload: { id: "1", content: "no matches found: /Users/someoneelse/x.md", isError: true },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assertNoLeaks(out);
});

test("bare username token (e.g. from `ls -la` output) is redacted", () => {
  const frame = {
    type: "tool_result",
    payload: { id: "1", content: "-rw-r--r--  1 aukim  staff  30 Jul  2 11:49 README.md", isError: false },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /\baukim\b/);
  assert.match(s, /<user>\s+staff/);
});

test("ordinary words containing the username substring are not mangled", () => {
  const frame = {
    type: "tool_result",
    payload: { id: "1", content: "aukimberly and notaukim are unrelated words", isError: false },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assert.equal(out.payload.content, "aukimberly and notaukim are unrelated words");
});

test("dash-mangled cwd form (Claude Code project dir naming) is redacted", () => {
  const dashCwd = CWD.replace(/\//g, "-");
  const frame = {
    type: "tool_result",
    payload: {
      id: "1",
      content: `~/.claude/projects/${dashCwd}/memory/MEMORY.md`,
      isError: false,
    },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assertNoLeaks(out);
  assert.doesNotMatch(JSON.stringify(out), /-private-var-folders-/);
});

test("catch-all redacts -private-var-folders- forms not matching the exact cwd", () => {
  const frame = {
    type: "tool_result",
    payload: {
      id: "1",
      content: "~/.claude/projects/-private-var-folders-xy-otherHash-T-some-other-session/memory/MEMORY.md",
      isError: false,
    },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assertNoLeaks(out);
  assert.doesNotMatch(JSON.stringify(out), /-private-var-folders-/);
});

test("OS display full name (injected via ctx) is redacted with word boundaries", () => {
  const frame = {
    type: "tool_result",
    payload: {
      id: "1",
      content: "Since I only know your name and email (Jane Doe, jane@example.com), ...",
      isError: false,
    },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME, fullName: "Jane Doe" });
  assert.equal(
    out.payload.content,
    "Since I only know your name and email (Demo User, <email>), ..."
  );
});

test("a full-name substring glued to other word characters is not mangled", () => {
  const frame = {
    type: "tool_result",
    payload: { id: "1", content: "xJane Doey is unrelated to a real match", isError: false },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME, fullName: "Jane Doe" });
  assert.equal(out.payload.content, "xJane Doey is unrelated to a real match");
});

test("email addresses are redacted", () => {
  const frame = {
    type: "tool_result",
    payload: { id: "1", content: "Welcome back, austinjuliuskim@gmail.com!", isError: false },
  };
  const out = normalizeFrame(frame, { cwd: CWD, home: HOME });
  assert.equal(out.payload.content, "Welcome back, <email>!");
});
