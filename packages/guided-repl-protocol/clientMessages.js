/**
 * Client -> server message parsing. This is a trust boundary: input may come
 * from an untrusted WebSocket peer, so every shape is validated and unknown
 * input throws rather than passing through.
 *
 * @typedef {{type: "prompt", text: string}} PromptMessage
 * @typedef {{type: "permission", decision: "approve"|"deny"}} PermissionMessage
 * @typedef {{type: "interrupt"}} InterruptMessage
 * @typedef {{type: "next"}} NextMessage
 * @typedef {PromptMessage|PermissionMessage|InterruptMessage|NextMessage} ClientMessage
 */

/** Session modes. Only GUIDED is used in the MVP. */
export const Mode = Object.freeze({
  GUIDED: "guided",
  BYOK: "byok",
  WALLET: "wallet",
});

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parses and validates a raw client message. Accepts a JSON string or an
 * already-parsed object.
 *
 * @param {string|object} raw
 * @returns {ClientMessage}
 * @throws {Error} if `raw` is not valid JSON, not an object, has an unknown
 *   type, or fails per-type field validation.
 */
export function parseClientMessage(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error("Invalid client message: not valid JSON");
    }
  }

  if (!isPlainObject(obj)) {
    throw new Error("Invalid client message: not an object");
  }

  switch (obj.type) {
    case "prompt": {
      if (typeof obj.text !== "string" || obj.text.length === 0) {
        throw new Error("Invalid client message: prompt.text must be a non-empty string");
      }
      return { type: "prompt", text: obj.text };
    }
    case "permission": {
      if (obj.decision !== "approve" && obj.decision !== "deny") {
        throw new Error('Invalid client message: permission.decision must be "approve" or "deny"');
      }
      return { type: "permission", decision: obj.decision };
    }
    case "interrupt": {
      return { type: "interrupt" };
    }
    case "next": {
      return { type: "next" };
    }
    default:
      throw new Error(`Invalid client message: unknown type ${JSON.stringify(obj.type)}`);
  }
}
