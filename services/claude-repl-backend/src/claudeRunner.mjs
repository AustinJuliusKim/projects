import { runCommand, WORKSPACE_DIR } from "./sandbox.mjs";
import { mapEvent } from "./streamMapper.mjs";
import { log } from "./log.mjs";

// Builds and runs the headless Claude Code command inside the sandbox, splits
// its NDJSON stdout into lines, maps each event, and invokes `onMessage` with
// every resulting protocol message.

// Quote a string for safe single-quoted shell embedding.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

export function buildCommand({ prompt, mode, resumeId, permissionToolName }) {
  const parts = [
    "claude",
    "-p",
    shellQuote(prompt),
    "--output-format stream-json",
    "--include-partial-messages",
    "--verbose",
    `--permission-mode ${mode}`,
    `--add-dir ${WORKSPACE_DIR}`,
  ];
  // Plan / Accept-edits route gated actions through our MCP approval tool.
  // Auto (bypassPermissions) needs no prompt tool.
  if (permissionToolName) {
    parts.push(`--permission-prompt-tool ${permissionToolName}`);
  }
  if (resumeId) parts.push(`--resume ${resumeId}`);
  return parts.join(" ");
}

// Runs one prompt. Returns a handle: { kill } and resolves `done` when the
// process exits. `onMessage` receives normalized protocol messages.
export async function runPrompt(sandbox, opts, onMessage) {
  const cmd = buildCommand(opts);
  let buffer = "";

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON noise on stdout (shouldn't happen with stream-json) — skip.
      return;
    }
    for (const msg of mapEvent(event)) onMessage(msg);
  };

  const handle = await runCommand(sandbox, cmd, {
    apiKey: opts.apiKey,
    onStdout: (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    },
    onStderr: (chunk) => log.warn({ stderr: chunk }, "claude stderr"),
  });

  // Flush any trailing partial line when the process ends.
  const done = handle.wait().finally(() => {
    if (buffer.trim()) handleLine(buffer);
  });

  return { handle, done };
}
