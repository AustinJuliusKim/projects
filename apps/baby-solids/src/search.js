/**
 * Ranked food search over the prebuilt index.
 *
 * NO fuzzy matching, no Levenshtein, no trigram similarity — deliberately.
 * Edit-distance scoring is exactly the mechanism that makes a well-known
 * competitor's search return "yam" for "sal": at distance 1-2, short queries
 * match almost anything, and the true prefix match loses to a shorter word.
 * Prefix-first tiering is both faster and correct here, and the corpus is
 * small enough that there is nothing to gain from anything cleverer.
 *
 * Pure and synchronous: no network, no async, no debounce needed.
 */

import { normalize } from "../scripts/searchIndex.js";

/**
 * Tiers, best first. The matcher stops climbing at the first tier that yields
 * results, so a genuine prefix hit is never diluted by weaker substring hits.
 */
const TIERS = [
  (q, e) => e.nameNorm === q,
  (q, e) => e.nameNorm.startsWith(q),
  (q, e) => e.aliasesNorm.some((a) => a === q),
  (q, e) => e.aliasesNorm.some((a) => a.startsWith(q)),
  (q, e) => e.tokens.some((t) => t.startsWith(q)),
  (q, e) => e.nameNorm.includes(q) || e.aliasesNorm.some((a) => a.includes(q)),
];

/**
 * @param {{entries: object[]}} index compiled search index
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]} food ids, best first
 */
export function searchFoods(index, query, limit = 50) {
  const q = normalize(query ?? "");
  if (!q) return [];
  for (const matches of TIERS) {
    const hit = index.entries.filter((e) => matches(q, e));
    if (hit.length) {
      // Deterministic within a tier: shorter names first (a prefix match on a
      // short name is a better answer), then alphabetical for stability.
      return hit
        .sort((a, b) => a.nameNorm.length - b.nameNorm.length || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((e) => e.id);
    }
  }
  return [];
}
