/**
 * Build-time search index.
 *
 * Emitted alongside the compiled foods so the runtime matcher is a pure
 * function over prebuilt data — no tokenizing on the keystroke path.
 *
 * Normalization is NFC + lowercase + punctuation-stripped. NFC matters for
 * Korean specifically: 고구마 can arrive decomposed (Jamo) or composed, and
 * without normalizing, a typed prefix silently fails to match an authored
 * alias that looks identical on screen.
 */

/**
 * @param {string} s
 * @returns {string}
 */
export function normalize(s) {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim();
}

/**
 * @param {string} s
 * @returns {string[]}
 */
export function tokenize(s) {
  return normalize(s).split(/[\s-]+/).filter(Boolean);
}

/**
 * @param {object[]} foods
 * @returns {{tokens: Record<string, string[]>, entries: object[]}}
 */
export function buildSearchIndex(foods) {
  /** @type {Record<string, string[]>} */
  const tokens = {};
  const entries = foods.map((f) => {
    const nameNorm = normalize(f.name);
    const aliasesNorm = (f.aliases ?? []).map(normalize);
    const categoryNorm = normalize(f.category);
    const all = [...tokenize(f.name), ...aliasesNorm.flatMap(tokenize), ...tokenize(f.category)];
    for (const t of new Set(all)) {
      (tokens[t] ??= []).push(f.id);
    }
    return {
      id: f.id,
      name: f.name,
      nameNorm,
      aliasesNorm,
      categoryNorm,
      tokens: [...new Set(all)],
    };
  });
  for (const ids of Object.values(tokens)) ids.sort();
  return { tokens, entries };
}
