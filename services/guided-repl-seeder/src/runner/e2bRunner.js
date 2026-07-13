/**
 * E2B-backed Runner: creates a sandbox from the `guided-repl-seeder`
 * template (node 20 + the `claude` CLI on PATH — see README), mirrors the
 * local workspace into it, runs `claude -p ... --output-format stream-json`
 * there, yields parsed NDJSON lines as they stream, and syncs the sandbox
 * workspace back to the local dir so snapshots/assertions see real state.
 *
 * The `e2b` SDK is imported lazily inside the default sandbox factory, so
 * tests (injected fake sandbox) and keyless CI never load it. Live use
 * needs E2B_API_KEY (SDK) and ANTHROPIC_API_KEY (passed into the sandbox).
 *
 * @implements {import("./runner.js").Runner}
 */

import fs from "node:fs";
import path from "node:path";

export const E2B_TEMPLATE = "guided-repl-seeder";
export const SANDBOX_WORKDIR = "/home/user/workspace";
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @typedef {object} SandboxLike
 * @property {{write: (path: string, data: string) => Promise<unknown>, read: (path: string) => Promise<string>}} files
 * @property {{run: (cmd: string, opts?: {cwd?: string, timeoutMs?: number, onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void}) => Promise<{exitCode: number, stdout: string, stderr: string}>}} commands
 * @property {() => Promise<unknown>} kill
 */

/**
 * Live factory: lazily imports the e2b SDK and creates a sandbox from the
 * template, passing ANTHROPIC_API_KEY through as sandbox env.
 *
 * @param {{template: string}} opts
 * @returns {Promise<SandboxLike>}
 */
async function defaultSandboxFactory({ template }) {
  const { Sandbox } = await import("e2b");
  return Sandbox.create(template, {
    envs: process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {},
  });
}

/** @param {string} s single-quote shell escaping */
function shq(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Recursively lists files under a local dir (skipping node_modules/.git). */
function walkLocal(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === ".git")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkLocal(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Minimal async queue bridging onStdout callbacks to an async iterator. */
function makeLineQueue() {
  const buffered = [];
  /** @type {{resolve: Function}|null} */
  let waiter = null;
  let doneWith = null;
  let partial = "";

  const settleWaiter = () => {
    if (!waiter) return;
    const { resolve } = waiter;
    if (buffered.length > 0) {
      waiter = null;
      resolve({ value: buffered.shift(), done: false });
    } else if (doneWith) {
      waiter = null;
      resolve(doneWith.error ? { error: doneWith.error } : { done: true });
    }
  };

  return {
    pushChunk(chunk) {
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) buffered.push(line);
      }
      settleWaiter();
    },
    finish(error) {
      if (partial.trim()) buffered.push(partial.trim());
      partial = "";
      doneWith = { error };
      settleWaiter();
    },
    async next() {
      if (buffered.length > 0) return { value: buffered.shift(), done: false };
      if (doneWith) return doneWith.error ? { error: doneWith.error } : { done: true };
      return new Promise((resolve) => {
        waiter = { resolve };
        settleWaiter();
      });
    },
  };
}

/**
 * @param {{sandboxFactory?: typeof defaultSandboxFactory, template?: string}} [opts]
 * @returns {import("./runner.js").Runner & {getVersion: () => Promise<string>}}
 */
export function createE2bRunner({ sandboxFactory = defaultSandboxFactory, template = E2B_TEMPLATE } = {}) {
  return {
    /**
     * @param {import("./runner.js").RunnerOptions} opts
     * @returns {AsyncIterable<object>}
     */
    async *run({ prompt, cwd, permissionMode, model }) {
      const sandbox = await sandboxFactory({ template });
      try {
        // 1. Mirror the local workspace into the sandbox.
        for (const rel of walkLocal(cwd)) {
          await sandbox.files.write(`${SANDBOX_WORKDIR}/${rel}`, fs.readFileSync(path.join(cwd, rel), "utf8"));
        }

        // 2. Run claude, streaming NDJSON lines out as they arrive.
        const args = [
          "claude",
          "-p",
          shq(prompt),
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--permission-mode",
          permissionMode,
          ...(model ? ["--model", shq(model)] : []),
        ];
        const queue = makeLineQueue();
        const exec = sandbox.commands
          .run(args.join(" "), {
            cwd: SANDBOX_WORKDIR,
            timeoutMs: COMMAND_TIMEOUT_MS,
            onStdout: (chunk) => queue.pushChunk(chunk),
          })
          .then(
            (result) =>
              queue.finish(
                result.exitCode === 0
                  ? undefined
                  : new Error(`e2bRunner: claude exited with code ${result.exitCode}. stderr: ${result.stderr ?? ""}`),
              ),
            (err) => queue.finish(err),
          );

        while (true) {
          const item = await queue.next();
          if (item.error) throw item.error;
          if (item.done) break;
          yield JSON.parse(item.value);
        }
        await exec;

        // 3. Sync sandbox workspace state back to the local dir so callers'
        // snapshots and assertions see what the run produced. (New and
        // modified files; deletions inside a 5-minute lesson run are rare
        // enough to punt on in v1.)
        const list = await sandbox.commands.run(
          `find ${SANDBOX_WORKDIR} -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`,
          { timeoutMs: 60_000 },
        );
        for (const remote of list.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
          if (!remote.startsWith(`${SANDBOX_WORKDIR}/`)) continue;
          const rel = remote.slice(`${SANDBOX_WORKDIR}/`.length);
          if (!rel) continue;
          const local = path.join(cwd, rel);
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, await sandbox.files.read(remote));
        }
      } finally {
        await sandbox.kill().catch(() => {});
      }
    },

    /**
     * Reports `claude --version` from inside the sandbox — the version that
     * actually records fixtures in CI, not the dev box's.
     *
     * @returns {Promise<string>}
     */
    async getVersion() {
      const sandbox = await sandboxFactory({ template });
      try {
        const result = await sandbox.commands.run("claude --version", { timeoutMs: 60_000 });
        if (result.exitCode !== 0) {
          throw new Error(`e2bRunner: claude --version failed with code ${result.exitCode}`);
        }
        return result.stdout.trim();
      } finally {
        await sandbox.kill().catch(() => {});
      }
    },
  };
}
