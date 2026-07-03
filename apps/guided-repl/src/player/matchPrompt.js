/**
 * Prompt-to-branch matching seam. v1 is exact match (trim + whitespace
 * collapse) so a future fuzzy matcher can land without touching callers.
 *
 * @typedef {{branchId: string, expectedPrompt: string}} PromptBranch
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Matches learner input text against a set of branches' expectedPrompt.
 *
 * @param {string} inputText
 * @param {PromptBranch[]} branches
 * @returns {{branchId: string}|null}
 */
export function matchPrompt(inputText, branches) {
  const normalizedInput = normalize(inputText);
  for (const branch of branches) {
    if (normalize(branch.expectedPrompt) === normalizedInput) {
      return { branchId: branch.branchId };
    }
  }
  return null;
}
