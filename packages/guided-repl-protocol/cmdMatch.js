/**
 * Command matching for TerminalDrill steps: does the learner's typed
 * command satisfy the drill's expectation?
 *
 * @typedef {{kind: "exact"|"regex", value: string}} CmdMatcher
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * @param {CmdMatcher} matcher
 * @param {string} input
 * @returns {boolean}
 */
export function matchCommand(matcher, input) {
  if (matcher.kind === "exact") {
    return normalize(matcher.value) === normalize(input);
  }
  return new RegExp(matcher.value).test(input.trim());
}
