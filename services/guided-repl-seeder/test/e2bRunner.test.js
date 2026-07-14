import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createE2bRunner, SANDBOX_WORKDIR, E2B_TEMPLATE } from "../src/runner/e2bRunner.js";
import { makeSeedWorkspace } from "../src/workspace.js";

/**
 * Fake sandbox: in-memory file store + scripted command results. Mimics the
 * e2b SDK surface the runner uses (files.write/read, commands.run, kill).
 */
function createFakeSandboxFactory({ ndjsonLines = [], exitCode = 0, versionOut = "2.5.0 (Claude Code)" } = {}) {
  const state = {
    created: 0,
    killed: 0,
    files: new Map(),
    commands: [],
  };

  async function factory({ template }) {
    state.created += 1;
    state.template = template;
    return {
      files: {
        write: async (p, data) => void state.files.set(p, data),
        read: async (p) => state.files.get(p) ?? "",
      },
      commands: {
        run: async (cmd, opts = {}) => {
          state.commands.push({ cmd, cwd: opts.cwd });
          if (cmd.startsWith("claude --version")) {
            return { exitCode: 0, stdout: `${versionOut}\n`, stderr: "" };
          }
          if (cmd.startsWith("find ")) {
            const listing = [...state.files.keys()].join("\n");
            return { exitCode: 0, stdout: `${listing}\n`, stderr: "" };
          }
          // the claude run: stream NDJSON via onStdout (split mid-line to
          // exercise chunk reassembly), then "write" a file in the sandbox.
          const payload = ndjsonLines.map((l) => JSON.stringify(l)).join("\n");
          if (opts.onStdout && payload) {
            const mid = Math.floor(payload.length / 2);
            opts.onStdout(payload.slice(0, mid));
            opts.onStdout(payload.slice(mid));
            opts.onStdout("\n");
          }
          state.files.set(`${SANDBOX_WORKDIR}/index.html`, "<h1>Hi</h1>\n");
          return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "boom" };
        },
      },
      kill: async () => void (state.killed += 1),
    };
  }

  return { factory, state };
}

const LINES = [
  { type: "system", subtype: "init", model: "claude-sonnet-4-6" },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
  { type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5 } },
];

test("run(): uploads workspace, streams parsed NDJSON, syncs files back, tears down", async () => {
  const { factory, state } = createFakeSandboxFactory({ ndjsonLines: LINES });
  const runner = createE2bRunner({ sandboxFactory: factory });
  const workspace = makeSeedWorkspace();
  try {
    const events = [];
    for await (const raw of runner.run({ prompt: "it's a 'test'", cwd: workspace, permissionMode: "acceptEdits" })) {
      events.push(raw);
    }
    assert.deepEqual(events, LINES, "NDJSON reassembled across chunk splits");

    // Upload: the starter README landed in the sandbox workspace.
    assert.ok(state.files.has(`${SANDBOX_WORKDIR}/README.md`));
    // Claude invocation shape (quoted prompt, right cwd + flags).
    const claudeCmd = state.commands.find((c) => c.cmd.startsWith("claude -p"));
    assert.ok(claudeCmd.cmd.includes("'it'\\''s a '\\''test'\\'''"), claudeCmd.cmd);
    assert.ok(claudeCmd.cmd.includes("--permission-mode acceptEdits"));
    assert.equal(claudeCmd.cwd, SANDBOX_WORKDIR);
    // Sync-back: the file the "run" created exists locally now.
    assert.equal(fs.readFileSync(path.join(workspace, "index.html"), "utf8"), "<h1>Hi</h1>\n");
    // Teardown.
    assert.equal(state.created, 1);
    assert.equal(state.killed, 1);
    assert.equal(state.template, E2B_TEMPLATE);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("run(): --model flag forwarded", async () => {
  const { factory, state } = createFakeSandboxFactory({ ndjsonLines: LINES });
  const runner = createE2bRunner({ sandboxFactory: factory });
  const workspace = makeSeedWorkspace();
  try {
    for await (const _ of runner.run({ prompt: "p", cwd: workspace, permissionMode: "plan", model: "claude-haiku-4-5" })) {
      // drain
    }
    const claudeCmd = state.commands.find((c) => c.cmd.startsWith("claude -p"));
    assert.ok(claudeCmd.cmd.includes("--model 'claude-haiku-4-5'"));
    assert.ok(claudeCmd.cmd.includes("--permission-mode plan"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("run(): non-zero exit throws and still tears the sandbox down", async () => {
  const { factory, state } = createFakeSandboxFactory({ ndjsonLines: LINES, exitCode: 1 });
  const runner = createE2bRunner({ sandboxFactory: factory });
  const workspace = makeSeedWorkspace();
  try {
    await assert.rejects(async () => {
      for await (const _ of runner.run({ prompt: "p", cwd: workspace, permissionMode: "acceptEdits" })) {
        // drain
      }
    }, /claude exited with code 1.*boom/s);
    assert.equal(state.killed, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("getVersion(): runs claude --version in-sandbox and tears down", async () => {
  const { factory, state } = createFakeSandboxFactory({ versionOut: "9.1.2 (Claude Code)" });
  const runner = createE2bRunner({ sandboxFactory: factory });
  assert.equal(await runner.getVersion(), "9.1.2 (Claude Code)");
  assert.equal(state.killed, 1);
});

test("e2b SDK is only reachable via lazy dynamic import (keyless CI)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/runner/e2bRunner.js", import.meta.url)), "utf8");
  assert.ok(!/^import .*["']e2b["']/m.test(src), "no static e2b import");
  assert.match(src, /await import\("e2b"\)/);
});
