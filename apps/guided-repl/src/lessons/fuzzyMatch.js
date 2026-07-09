/**
 * Suggestion filtering for the PromptComposer: prefix matches rank above
 * subsequence matches; non-matches drop out. No dependency — scoring is
 * deliberately simple (the guided suggestion sets are tiny).
 */

/**
 * @param {string} text
 * @returns {string}
 */
function fold(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * @param {string} input
 * @param {string} candidate
 * @returns {number} 2 = prefix match, 1 = subsequence match, 0 = no match
 */
export function scoreSuggestion(input, candidate) {
  const needle = fold(input);
  const haystack = fold(candidate);
  if (needle.length === 0) return 2;
  if (haystack.startsWith(needle)) return 2;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return 1;
  }
  return 0;
}

/**
 * Filters and ranks suggestions for the current input. Stable within a
 * score band (authored order is the tiebreak).
 *
 * @param {string} input
 * @param {Array<{text: string}>} suggestions
 * @returns {Array<{text: string}>}
 */
export function filterSuggestions(input, suggestions) {
  return suggestions
    .map((suggestion, index) => ({ suggestion, index, score: scoreSuggestion(input, suggestion.text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.suggestion);
}
