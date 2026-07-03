/**
 * Assembles a learner's segmented choice selections into the flat prompt
 * text the fixture branches match against.
 *
 * @typedef {{task: string, subject: string, constraint: string}} PromptChoiceSelection
 */

/**
 * @param {PromptChoiceSelection} selection
 * @returns {string}
 */
export function buildPrompt({ task, subject, constraint }) {
  return task + " " + subject + (constraint ? ", " + constraint : "");
}
