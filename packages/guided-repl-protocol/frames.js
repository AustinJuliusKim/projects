/**
 * Server -> client frame vocabulary for the Guided REPL transport.
 *
 * @typedef {{delta: string}} TextPayload
 * @typedef {{id: string, tool: string, input: object}} ToolUsePayload
 * @typedef {{id: string, content: string, isError: boolean}} ToolResultPayload
 * @typedef {{id: string, tool: string, input: object}} PermissionRequestPayload
 * @typedef {{inputTokens: number, outputTokens: number, costUsd?: number, model?: string}} UsagePayload
 * @typedef {{tree: object}} FileTreePayload
 * @typedef {{path: string, content: string}} FileContentPayload
 * @typedef {{message: string, code: string}} ErrorPayload
 *
 * @typedef {{type: "session_ready"}} SessionReadyFrame
 * @typedef {{type: "text", payload: TextPayload}} TextFrame
 * @typedef {{type: "tool_use", payload: ToolUsePayload}} ToolUseFrame
 * @typedef {{type: "tool_result", payload: ToolResultPayload}} ToolResultFrame
 * @typedef {{type: "permission_request", payload: PermissionRequestPayload}} PermissionRequestFrame
 * @typedef {{type: "usage", payload: UsagePayload}} UsageFrame
 * @typedef {{type: "file_tree", payload: FileTreePayload}} FileTreeFrame
 * @typedef {{type: "file_content", payload: FileContentPayload}} FileContentFrame
 * @typedef {{type: "done"}} DoneFrame
 * @typedef {{type: "error", payload: ErrorPayload}} ErrorFrame
 *
 * @typedef {SessionReadyFrame|TextFrame|ToolUseFrame|ToolResultFrame|PermissionRequestFrame|UsageFrame|FileTreeFrame|FileContentFrame|DoneFrame|ErrorFrame} ServerFrame
 */

export const SESSION_READY = "session_ready";
export const TEXT = "text";
export const TOOL_USE = "tool_use";
export const TOOL_RESULT = "tool_result";
export const PERMISSION_REQUEST = "permission_request";
export const USAGE = "usage";
export const FILE_TREE = "file_tree";
export const FILE_CONTENT = "file_content";
export const DONE = "done";
export const ERROR = "error";

/** Frozen set of all known server frame types. */
export const SERVER_TYPES = Object.freeze(
  new Set([
    SESSION_READY,
    TEXT,
    TOOL_USE,
    TOOL_RESULT,
    PERMISSION_REQUEST,
    USAGE,
    FILE_TREE,
    FILE_CONTENT,
    DONE,
    ERROR,
  ])
);

const isString = (v) => typeof v === "string";
const isBoolean = (v) => typeof v === "boolean";
const isNumber = (v) => typeof v === "number";
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Per-type required-field checks for frames that carry a `payload`.
 * @type {Record<string, (payload: unknown) => boolean>}
 */
const PAYLOAD_CHECKS = {
  [TEXT]: (p) => isPlainObject(p) && isString(p.delta),
  [TOOL_USE]: (p) => isPlainObject(p) && isString(p.id) && isString(p.tool) && isPlainObject(p.input),
  [TOOL_RESULT]: (p) =>
    isPlainObject(p) && isString(p.id) && isString(p.content) && isBoolean(p.isError),
  [PERMISSION_REQUEST]: (p) =>
    isPlainObject(p) && isString(p.id) && isString(p.tool) && isPlainObject(p.input),
  [USAGE]: (p) =>
    isPlainObject(p) &&
    isNumber(p.inputTokens) &&
    isNumber(p.outputTokens) &&
    ("costUsd" in p ? isNumber(p.costUsd) : true) &&
    ("model" in p ? isString(p.model) : true),
  [FILE_TREE]: (p) => isPlainObject(p) && isPlainObject(p.tree),
  [FILE_CONTENT]: (p) => isPlainObject(p) && isString(p.path) && isString(p.content),
  [ERROR]: (p) => isPlainObject(p) && isString(p.message) && isString(p.code),
};

/** Frame types that carry no payload. */
const NO_PAYLOAD_TYPES = new Set([SESSION_READY, DONE]);

/**
 * Checks whether `x` is a well-formed ServerFrame: a plain object with a
 * known `type` and, for payload-bearing types, a payload satisfying that
 * type's required fields.
 *
 * @param {unknown} x
 * @returns {x is ServerFrame}
 */
export function isServerFrame(x) {
  if (!isPlainObject(x)) return false;
  if (!isString(x.type) || !SERVER_TYPES.has(x.type)) return false;
  if (NO_PAYLOAD_TYPES.has(x.type)) return true;
  const check = PAYLOAD_CHECKS[x.type];
  return check ? check(x.payload) : false;
}
