/**
 * Local child-process Runner: spawns `claude -p ...` in a caller-provided
 * tmp workspace and async-iterates its NDJSON stream-json output.
 *
 * @implements {import("./runner.js").Runner}
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/services/guided-repl-seeder/src/runner/localRunner.js.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_GUARD_PREFIX = realpathSync(path.resolve(MODULE_DIR, "../../../.."));

/**
 * Throws if `cwd` is missing, not a directory, or lives under the repo
 * (services/apps/packages source must never be used as a run workspace).
 *
 * @param {string} cwd
 */
function assertSafeCwd(cwd) {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`localRunner: cwd does not exist or is not a directory: ${cwd}`);
  }
  const resolved = realpathSync(cwd);
  if (resolved === REPO_GUARD_PREFIX || resolved.startsWith(REPO_GUARD_PREFIX + path.sep)) {
    throw new Error(
      `localRunner: refusing to run with cwd under the repo (${REPO_GUARD_PREFIX}): ${resolved}`
    );
  }
}

/**
 * @param {import("./runner.js").RunnerOptions} opts
 * @returns {AsyncIterable<object>}
 */
export async function* run(opts) {
  const { prompt, cwd, permissionMode, model } = opts;
  assertSafeCwd(cwd);

  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];
  if (model) {
    args.push("--model", model);
  }

  const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed);
    }
  } finally {
    rl.close();
  }

  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(`localRunner: claude exited with code ${exitCode}. stderr: ${stderr}`);
  }
}
