// Shared WebSocket message contract for claude-repl.
// Consumed by both apps/claude-repl (browser) and services/claude-repl-backend
// via a `file:` dependency so the two sides can't drift apart.

/** Messages the browser sends to the backend. */
export const ClientMsg = Object.freeze({
  SET_KEY: "setKey", // { key }            — user's Anthropic API key (BYOK)
  PROMPT: "prompt", // { text }            — run a prompt
  SET_MODE: "setMode", // { mode }         — permission mode (see Mode)
  APPROVE: "approve", // { id }            — approve a pending permission request
  DENY: "deny", // { id, reason? }         — deny a pending permission request
  INTERRUPT: "interrupt", // {}            — abort the active run
});

/** Messages the backend sends to the browser. */
export const ServerMsg = Object.freeze({
  SESSION_READY: "session_ready", // {}                         — sandbox booted, ready for prompts
  TEXT: "text", // { delta }                                    — assistant text chunk
  TOOL_USE: "tool_use", // { id, tool, input }                  — Claude invoked a tool
  TOOL_RESULT: "tool_result", // { id, content, isError }       — tool finished
  PERMISSION_REQUEST: "permission_request", // { id, tool, input } — awaiting approve/deny
  USAGE: "usage", // { inputTokens, outputTokens, cacheReadTokens, costUsd, runs }
  FILE_TREE: "file_tree", // { tree }                           — reconciled workspace tree
  FILE_CONTENT: "file_content", // { path, content }            — a single file's contents
  DONE: "done", // {}                                           — run finished
  ERROR: "error", // { message, code }                          — run/session error
});

/** Permission modes, mapped to Claude Code's --permission-mode. */
export const Mode = Object.freeze({
  PLAN: "plan", // research + propose, gate edits
  ACCEPT_EDITS: "acceptEdits", // auto-approve edits, gate other tools
  AUTO: "bypassPermissions", // run everything unattended (sandbox-only)
});

const CLIENT_TYPES = new Set(Object.values(ClientMsg));
const SERVER_TYPES = new Set(Object.values(ServerMsg));
const MODES = new Set(Object.values(Mode));

/** True if `value` is one of the allowed permission modes. */
export function isMode(value) {
  return MODES.has(value);
}

/**
 * Parse + validate a raw WS frame coming from the browser.
 * Returns the parsed message, or throws on malformed/unknown input.
 * Keep this strict: it's the trust boundary for the backend.
 */
export function parseClientMessage(raw) {
  let msg;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("invalid JSON");
  }
  if (!msg || typeof msg !== "object" || !CLIENT_TYPES.has(msg.type)) {
    throw new Error(`unknown client message type: ${msg && msg.type}`);
  }
  switch (msg.type) {
    case ClientMsg.SET_KEY:
      if (typeof msg.key !== "string" || msg.key.length === 0) {
        throw new Error("setKey requires a non-empty key");
      }
      break;
    case ClientMsg.PROMPT:
      if (typeof msg.text !== "string" || msg.text.trim().length === 0) {
        throw new Error("prompt requires non-empty text");
      }
      break;
    case ClientMsg.SET_MODE:
      if (!isMode(msg.mode)) throw new Error(`invalid mode: ${msg.mode}`);
      break;
    case ClientMsg.APPROVE:
    case ClientMsg.DENY:
      if (typeof msg.id !== "string" || msg.id.length === 0) {
        throw new Error(`${msg.type} requires an id`);
      }
      break;
    // INTERRUPT carries no payload.
  }
  return msg;
}

/** Build a server→client frame (a JSON string ready for ws.send). */
export function serverMessage(type, payload = {}) {
  if (!SERVER_TYPES.has(type)) {
    throw new Error(`unknown server message type: ${type}`);
  }
  return JSON.stringify({ type, ...payload });
}
