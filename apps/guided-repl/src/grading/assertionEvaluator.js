/**
 * Grades a lesson attempt's final state against a declarative assertion.
 *
 * @typedef {import("@guided-repl/protocol").Assertion} Assertion
 * @typedef {import("../lib/virtualFs.js").VFiles} VFiles
 * @typedef {{pass: boolean, detail: string}} GradeResult
 */

import { getFile } from "../lib/virtualFs.js";

/**
 * @param {object} message
 * @returns {string}
 */
function messageContent(message) {
  if (message.role === "tool") return message.result?.content ?? "";
  if (message.role === "error") return message.message ?? "";
  return message.text ?? "";
}

/**
 * @param {Assertion} assertion
 * @param {{files: VFiles, messages: Array<object>, quizAnswer?: number}} attemptState
 * @returns {GradeResult}
 */
export function evaluate(assertion, { files, messages, quizAnswer }) {
  switch (assertion.type) {
    case "file-contains": {
      const file = getFile(files, assertion.path);
      if (!file) {
        return { pass: false, detail: `${assertion.path} was not created` };
      }
      const pass = file.content.includes(assertion.match);
      return {
        pass,
        detail: pass
          ? `${assertion.path} contains "${assertion.match}"`
          : `${assertion.path} does not contain "${assertion.match}"`,
      };
    }

    case "file-exists": {
      const pass = Boolean(getFile(files, assertion.path));
      return {
        pass,
        detail: pass ? `${assertion.path} exists` : `${assertion.path} was not created`,
      };
    }

    case "terminal-matches": {
      const pass = (messages ?? []).some((m) => messageContent(m).includes(assertion.match));
      return {
        pass,
        detail: pass
          ? `terminal output contains "${assertion.match}"`
          : `terminal output does not contain "${assertion.match}"`,
      };
    }

    case "file-equals": {
      const file = getFile(files, assertion.path);
      const pass = Boolean(file) && file.content === assertion.content;
      return {
        pass,
        detail: pass ? `${assertion.path} matches expected content` : `${assertion.path} does not match expected content`,
      };
    }

    case "quiz": {
      if (quizAnswer === undefined || quizAnswer === null) {
        return { pass: false, detail: "Select an answer to continue" };
      }
      const pass = quizAnswer === assertion.correctIndex;
      return {
        pass,
        detail: pass ? "Correct" : "Not quite — review the transcript and try again",
      };
    }

    default:
      return { pass: false, detail: `Unknown assertion type: ${assertion.type}` };
  }
}
