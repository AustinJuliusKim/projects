import { ServerMsg, Mode } from "@me/claude-repl-protocol";
import { applyToolUse, mergeTree } from "../lib/virtualFs.js";

// Single reducer over the server event stream — the heart of the app. Every
// server→client message folds into this normalized UI state.

export const initialState = {
  status: "disconnected", // disconnected | connecting | needs_key | booting | ready | running
  mode: Mode.ACCEPT_EDITS,
  messages: [], // ordered log: {kind:'user'|'assistant'|'tool'|'system', ...}
  files: {}, // path -> { content, prevContent }
  openFile: null, // path currently shown in the viewer
  usage: null, // { inputTokens, outputTokens, cacheReadTokens, costUsd, runs, tokenCap }
  permission: null, // { id, tool, input } when awaiting approve/deny
  error: null,
};

export function reducer(state, action) {
  switch (action.type) {
    // ---- local UI actions ----
    case "ws_connecting":
      return { ...state, status: "connecting", error: null };
    case "ws_open":
      return { ...state, status: "needs_key" };
    case "ws_closed":
      return { ...state, status: "disconnected" };
    case "set_mode":
      return { ...state, mode: action.mode };
    case "key_submitted":
      return { ...state, status: "booting" };
    case "prompt_sent":
      return {
        ...state,
        status: "running",
        messages: [...state.messages, { kind: "user", text: action.text }],
      };
    case "open_file":
      return { ...state, openFile: action.path };
    case "file_loaded":
      return {
        ...state,
        files: { ...state.files, [action.path]: { ...state.files[action.path], content: action.content } },
      };

    // ---- server messages ----
    case ServerMsg.SESSION_READY:
      return { ...state, status: state.status === "running" ? "running" : "ready" };

    case ServerMsg.TEXT:
      return { ...state, messages: appendAssistant(state.messages, action.delta) };

    case ServerMsg.TOOL_USE:
      return {
        ...state,
        files: applyToolUse(state.files, action.tool, action.input),
        messages: [...state.messages, { kind: "tool", id: action.id, tool: action.tool, input: action.input }],
      };

    case ServerMsg.TOOL_RESULT:
      return { ...state, messages: attachToolResult(state.messages, action) };

    case ServerMsg.PERMISSION_REQUEST:
      return { ...state, permission: { id: action.id, tool: action.tool, input: action.input } };

    case ServerMsg.USAGE:
      return { ...state, usage: action };

    case ServerMsg.FILE_TREE:
      return { ...state, files: mergeTree(state.files, action.tree) };

    case ServerMsg.FILE_CONTENT:
      return {
        ...state,
        files: { ...state.files, [action.path]: { ...state.files[action.path], content: action.content } },
      };

    case ServerMsg.DONE:
      return { ...state, status: "ready", permission: null };

    case ServerMsg.ERROR:
      return { ...state, error: action.message, status: state.status === "running" ? "ready" : state.status };

    default:
      return state;
  }
}

// Append a text delta to the trailing assistant message, or start a new one.
function appendAssistant(messages, delta) {
  const last = messages[messages.length - 1];
  if (last && last.kind === "assistant") {
    const updated = { ...last, text: last.text + delta };
    return [...messages.slice(0, -1), updated];
  }
  return [...messages, { kind: "assistant", text: delta }];
}

function attachToolResult(messages, action) {
  return messages.map((m) =>
    m.kind === "tool" && m.id === action.id
      ? { ...m, result: action.content, isError: action.isError }
      : m,
  );
}
