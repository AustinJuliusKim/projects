/**
 * Pure reducer over flat ServerFrames (dispatched unmodified from any
 * transport) plus local UI actions. Transport-agnostic by construction: no
 * branch anywhere checks "is this a replay" (architecture invariant §12).
 *
 * @typedef {import("@guided-repl/protocol").ServerFrame} ServerFrame
 * @typedef {{type: "prompt_sent", text: string}} PromptSentAction
 * @typedef {{type: "hint_shown", hint: object}} HintShownAction
 * @typedef {{type: "permission_resolved", decision: "approve"|"deny"}} PermissionResolvedAction
 * @typedef {{type: "grade_set", grade: object}} GradeSetAction
 * @typedef {{type: "open_file", path: string}} OpenFileAction
 * @typedef {{type: "reset"}} ResetAction
 * @typedef {{type: "annotation_shown", annotation: object}} AnnotationShownAction
 * @typedef {{type: "annotation_cleared"}} AnnotationClearedAction
 * @typedef {PromptSentAction|HintShownAction|PermissionResolvedAction|GradeSetAction|OpenFileAction|ResetAction|AnnotationShownAction|AnnotationClearedAction} LocalAction
 * @typedef {ServerFrame|LocalAction} SessionAction
 *
 * @typedef {object} SessionState
 * @property {"idle"|"running"|"awaiting_permission"|"done"} status
 * @property {Array<object>} messages
 * @property {import("../lib/virtualFs.js").VFiles} files
 * @property {string|null} openFile
 * @property {object|null} usage
 * @property {object|null} permission
 * @property {object|null} grade
 * @property {object|null} hint
 * @property {object|null} annotation
 */

import { applyToolUse, mergeTree, normalizePath } from "../lib/virtualFs.js";

/** @returns {SessionState} */
export function createInitialState() {
  return {
    status: "idle",
    messages: [],
    files: {},
    openFile: null,
    usage: null,
    permission: null,
    grade: null,
    hint: null,
    annotation: null,
  };
}

/**
 * @param {SessionState} state
 * @param {SessionAction} action
 * @returns {SessionState}
 */
export function reducer(state, action) {
  switch (action.type) {
    case "session_ready":
      return { ...state, status: "running" };

    case "text": {
      const { delta } = action.payload;
      const messages = state.messages.slice();
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, text: last.text + delta };
      } else {
        messages.push({ role: "assistant", text: delta });
      }
      return { ...state, messages };
    }

    case "tool_use": {
      const { id, tool, input } = action.payload;
      const messages = [...state.messages, { role: "tool", id, tool, input, result: null }];
      const files = applyToolUse(state.files, tool, input);
      return { ...state, messages, files };
    }

    case "tool_result": {
      const { id, content, isError } = action.payload;
      const messages = state.messages.map((m) =>
        m.role === "tool" && m.id === id ? { ...m, result: { content, isError } } : m
      );
      return { ...state, messages };
    }

    case "permission_request":
      return { ...state, status: "awaiting_permission", permission: action.payload };

    case "usage":
      return { ...state, usage: action.payload };

    case "file_tree":
      return { ...state, files: mergeTree(state.files, action.payload.tree) };

    case "file_content": {
      const { path, content } = action.payload;
      const key = normalizePath(path);
      const files = { ...state.files, [key]: { content, prevContent: state.files[key]?.content } };
      return { ...state, files };
    }

    case "done":
      return { ...state, status: "done" };

    case "error": {
      const messages = [...state.messages, { role: "error", ...action.payload }];
      return { ...state, messages };
    }

    case "prompt_sent": {
      const messages = [...state.messages, { role: "user", text: action.text }];
      return { ...state, messages, hint: null };
    }

    case "hint_shown":
      return { ...state, hint: action.hint };

    case "permission_resolved":
      return { ...state, status: "running", permission: null };

    case "grade_set":
      return { ...state, grade: action.grade };

    case "open_file":
      return { ...state, openFile: action.path };

    case "annotation_shown":
      return { ...state, annotation: action.annotation };

    // Cleared explicitly by useSession.next() rather than implicitly on the
    // next frame's arrival — the frame stream stays verbatim (no markers
    // added per beat), so "the annotation is gone" is a local UI signal,
    // not something inferable from the next ServerFrame.
    case "annotation_cleared":
      return { ...state, annotation: null };

    case "reset":
      return createInitialState();

    default:
      return state;
  }
}
