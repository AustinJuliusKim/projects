import { Sandbox } from "e2b";
import { log } from "./log.mjs";

// Thin wrapper around the E2B SDK so the rest of the backend never imports the
// provider directly — swapping to Modal/Daytona later means rewriting only this
// file. One sandbox == one REPL session.

export const WORKSPACE_DIR = "/home/user/workspace";
const IGNORE_DIRS = new Set(["node_modules", ".git", ".cache"]);

export async function createSandbox() {
  const opts = {
    // Provider-side backstop: even if our backend crashes, an orphaned sandbox
    // dies on its own. The SessionManager idle timer is the primary control.
    timeoutMs: Number(process.env.IDLE_TIMEOUT_MS) || 300_000,
  };
  const template = process.env.E2B_TEMPLATE;
  const sandbox = template
    ? await Sandbox.create(template, opts)
    : await Sandbox.create(opts);
  log.info({ sandboxId: sandbox.sandboxId }, "sandbox created");
  await sandbox.files.makeDir(WORKSPACE_DIR).catch(() => {});
  return sandbox;
}

// Run Claude Code (or any command) in the background, streaming stdout/stderr
// line callbacks. Returns a handle with kill(). The API key is passed via env
// for this invocation only — it is never written to the sandbox disk.
export async function runCommand(sandbox, cmd, { apiKey, onStdout, onStderr } = {}) {
  return sandbox.commands.run(cmd, {
    background: true,
    cwd: WORKSPACE_DIR,
    envs: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {},
    onStdout,
    onStderr,
  });
}

// List the workspace tree (for the right-pane file tree), skipping noise dirs.
export async function listWorkspace(sandbox) {
  const entries = await sandbox.files.list(WORKSPACE_DIR, { depth: 10 });
  return entries
    .filter((e) => !pathHasIgnoredDir(e.path))
    .map((e) => ({
      path: e.path.replace(`${WORKSPACE_DIR}/`, ""),
      type: e.type, // "file" | "dir"
    }));
}

export async function readFile(sandbox, relPath) {
  return sandbox.files.read(`${WORKSPACE_DIR}/${relPath}`);
}

export async function killSandbox(sandbox) {
  if (!sandbox) return;
  try {
    await sandbox.kill();
    log.info({ sandboxId: sandbox.sandboxId }, "sandbox killed");
  } catch (err) {
    log.warn({ err }, "sandbox kill failed");
  }
}

function pathHasIgnoredDir(p) {
  return p.split("/").some((seg) => IGNORE_DIRS.has(seg));
}
