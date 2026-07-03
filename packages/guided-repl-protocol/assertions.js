/**
 * Lesson grading assertions: declarative checks run against the final
 * workspace / terminal state of a lesson attempt.
 *
 * @typedef {{type: "file-contains", path: string, match: string}} FileContainsAssertion
 * @typedef {{type: "file-exists", path: string}} FileExistsAssertion
 * @typedef {{type: "terminal-matches", match: string}} TerminalMatchesAssertion
 * @typedef {{type: "file-equals", path: string, content: string}} FileEqualsAssertion
 * @typedef {{type: "quiz", question: string, choices: string[], correctIndex: number}} QuizAssertion
 * @typedef {FileContainsAssertion|FileExistsAssertion|TerminalMatchesAssertion|FileEqualsAssertion|QuizAssertion} Assertion
 */

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === "string";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

/**
 * Validates an Assertion object, throwing with a precise message on the
 * first problem found.
 *
 * @param {unknown} a
 * @returns {asserts a is Assertion}
 * @throws {Error}
 */
export function validateAssertion(a) {
  if (!isPlainObject(a)) {
    throw new Error("Invalid assertion: not an object");
  }

  switch (a.type) {
    case "file-contains":
      if (!isString(a.path)) throw new Error("Invalid file-contains assertion: path must be a string");
      if (!isString(a.match)) throw new Error("Invalid file-contains assertion: match must be a string");
      return;
    case "file-exists":
      if (!isString(a.path)) throw new Error("Invalid file-exists assertion: path must be a string");
      return;
    case "terminal-matches":
      if (!isString(a.match)) throw new Error("Invalid terminal-matches assertion: match must be a string");
      return;
    case "file-equals":
      if (!isString(a.path)) throw new Error("Invalid file-equals assertion: path must be a string");
      if (!isString(a.content)) throw new Error("Invalid file-equals assertion: content must be a string");
      return;
    case "quiz":
      if (!isString(a.question)) throw new Error("Invalid quiz assertion: question must be a string");
      if (!Array.isArray(a.choices) || a.choices.length < 2 || !a.choices.every(isString)) {
        throw new Error("Invalid quiz assertion: choices must be an array of at least 2 strings");
      }
      if (!isInt(a.correctIndex) || a.correctIndex < 0 || a.correctIndex >= a.choices.length) {
        throw new Error("Invalid quiz assertion: correctIndex must be an integer within the choices range");
      }
      return;
    default:
      throw new Error(`Invalid assertion: unknown type ${JSON.stringify(a.type)}`);
  }
}
