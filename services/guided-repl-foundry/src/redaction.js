/**
 * Redaction gate over everything the Foundry writes into a PR (notes, radar
 * cards, fixtures, PR bodies). Patterns mirror
 * apps/guided-repl/scripts/checkLessons.js — every match is a leak that must
 * not ship.
 */

export const REDACTION_PATTERNS = [
  { name: "/Users/ path", re: /\/Users\// },
  { name: "/private path", re: /\/private/ },
  { name: "/var/folders path", re: /\/var\/folders/ },
  { name: "dash-mangled -private-var-folders- path", re: /-private-var-folders-/ },
  { name: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "UUIDv4", re: /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i },
  { name: "sk-ant- key", re: /sk-ant-/ },
];

/**
 * @param {string} text
 * @returns {{name: string, match: string}[]} every leak found (empty = clean)
 */
export function findRedactionLeaks(text) {
  const leaks = [];
  for (const { name, re } of REDACTION_PATTERNS) {
    const match = text.match(re);
    if (match) leaks.push({ name, match: match[0] });
  }
  return leaks;
}

/**
 * Throws when `text` trips any redaction pattern.
 *
 * @param {string} text
 * @param {string} label error-message context (e.g. "scout note for hf-blog")
 */
export function assertRedacted(text, label) {
  const leaks = findRedactionLeaks(text);
  if (leaks.length > 0) {
    const detail = leaks.map((l) => `${l.name} (${JSON.stringify(l.match)})`).join(", ");
    throw new Error(`redaction: ${label} contains ${detail}`);
  }
}
