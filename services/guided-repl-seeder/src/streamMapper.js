/**
 * Pure mapping from a raw `claude -p --output-format stream-json` NDJSON
 * event to zero or more protocol ServerFrames. Written against real probe
 * captures (test/fixtures/raw/*.ndjson) — see RECORDER.md.
 *
 * Observed raw event shapes (probe-confirmed):
 *   - {type:"system", subtype:"init", cwd, session_id, tools, model, permissionMode, ...}
 *   - {type:"system", subtype:"status" | other, ...}
 *   - {type:"assistant", message:{content:[{type:"text"|"thinking"|"tool_use", ...}]}}
 *   - {type:"user", message:{content:[{type:"tool_result", content, is_error, tool_use_id}]}}
 *   - {type:"stream_event", event:{type:"message_start"|"message_stop"|"message_delta"|
 *       "content_block_start"|"content_block_stop"|"content_block_delta", delta:{type:"text_delta"|
 *       "input_json_delta"|"signature_delta", ...}}}
 *   - {type:"rate_limit_event", ...}
 *   - {type:"result", subtype:"success"|other, usage:{input_tokens,output_tokens}, ...}
 */

/**
 * @typedef {import("@guided-repl/protocol").ServerFrame} ServerFrame
 */

/**
 * Flattens a tool_result's `content` field (string, or an array of
 * content blocks) into a single string.
 *
 * @param {unknown} content
 * @returns {string}
 */
function flattenToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
      .join("");
  }
  return "";
}

/**
 * Maps a single raw NDJSON event to zero or more ServerFrames.
 *
 * @param {object} raw
 * @returns {ServerFrame[]}
 */
export function mapEvent(raw) {
  if (!raw || typeof raw !== "object") return [];

  switch (raw.type) {
    case "system": {
      if (raw.subtype === "init") {
        return [{ type: "session_ready" }];
      }
      return [];
    }

    case "stream_event": {
      const event = raw.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        return [{ type: "text", payload: { delta: event.delta.text } }];
      }
      return [];
    }

    case "assistant": {
      const blocks = raw.message?.content ?? [];
      return blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          type: "tool_use",
          payload: { id: b.id, tool: b.name, input: b.input ?? {} },
        }));
    }

    case "user": {
      const blocks = raw.message?.content ?? [];
      return blocks
        .filter((b) => b.type === "tool_result")
        .map((b) => ({
          type: "tool_result",
          payload: {
            id: b.tool_use_id,
            content: flattenToolResultContent(b.content),
            isError: b.is_error === true,
          },
        }));
    }

    case "result": {
      if (raw.subtype === "success") {
        return [
          {
            type: "usage",
            payload: {
              inputTokens: raw.usage?.input_tokens ?? 0,
              outputTokens: raw.usage?.output_tokens ?? 0,
            },
          },
          { type: "done" },
        ];
      }
      return [
        {
          type: "error",
          payload: {
            message: raw.result ?? "unknown error",
            code: raw.subtype ?? "error",
          },
        },
      ];
    }

    case "error": {
      return [
        {
          type: "error",
          payload: {
            message: raw.message ?? raw.error ?? "unknown error",
            code: raw.code ?? "error",
          },
        },
      ];
    }

    // rate_limit_event and any other unrecognized top-level types carry no
    // client-visible signal.
    default:
      return [];
  }
}
