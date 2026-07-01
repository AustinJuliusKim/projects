import { ServerMsg } from "@me/claude-repl-protocol";

// Normalize one Claude Code stream-json event into zero or more protocol
// messages for the browser. Pure function — no I/O — so it's easy to unit test
// against recorded fixtures. Returns an array of { type, ...payload }.
//
// NOTE: stream-json event shapes vary across Claude Code versions. This mapper
// is intentionally defensive (optional chaining, type guards) and falls through
// to [] for anything it doesn't recognize. Confirm shapes against live output
// during Phase 0 before relying on any single field.
export function mapEvent(event) {
  if (!event || typeof event !== "object") return [];

  switch (event.type) {
    case "system":
      // The init event carries the session_id we need for --resume.
      if (event.subtype === "init") {
        return [{ type: ServerMsg.SESSION_READY, sessionId: event.session_id }];
      }
      return [];

    case "assistant":
      return mapAssistant(event.message);

    case "user":
      // Tool results come back wrapped as a synthetic user turn.
      return mapToolResults(event.message);

    case "result":
      return mapResult(event);

    default:
      // stream_event partial deltas (when --include-partial-messages is on).
      if (event.type === "stream_event") return mapPartial(event.event);
      return [];
  }
}

function mapAssistant(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      out.push({ type: ServerMsg.TEXT, delta: block.text });
    } else if (block.type === "tool_use") {
      out.push({
        type: ServerMsg.TOOL_USE,
        id: block.id,
        tool: block.name,
        input: block.input ?? {},
      });
    }
  }
  return out;
}

function mapToolResults(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      out.push({
        type: ServerMsg.TOOL_RESULT,
        id: block.tool_use_id,
        content: flattenContent(block.content),
        isError: Boolean(block.is_error),
      });
    }
  }
  return out;
}

function mapResult(event) {
  const u = event.usage ?? {};
  return [
    {
      type: ServerMsg.USAGE,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      costUsd: event.total_cost_usd ?? 0,
    },
    { type: ServerMsg.DONE },
  ];
}

function mapPartial(inner) {
  if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
    return [{ type: ServerMsg.TEXT, delta: inner.delta.text }];
  }
  return [];
}

// tool_result content can be a string or an array of {type:'text', text}.
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  }
  return "";
}
