/**
 * Deterministic lesson-order assignment.
 *
 * The author copies `order` from the l1 exemplar in the prompt pack, so an
 * authored draft emits `order: 1` and collides with l1 at the compile-time
 * uniqueness check (packages/guided-repl-lessons compile). We overwrite the
 * model's order with a corpus-unique one before validation — patching the
 * YAML *text* (what gets staged + committed), not just the parsed doc.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { DEFAULT_LESSONS_DIR } from "../overlap/lessonIndex.js";

/**
 * Highest `order` across the committed lessons, plus one — so new lessons
 * sort after the existing corpus (l1–l8 → 9).
 *
 * @param {string} [lessonsDir]
 * @returns {number}
 */
export function nextLessonOrder(lessonsDir = DEFAULT_LESSONS_DIR) {
  const files = readdirSync(lessonsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  let max = 0;
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(lessonsDir, file), "utf8"));
    if (typeof doc?.order === "number" && doc.order > max) max = doc.order;
  }
  return max + 1;
}

const ORDER_LINE = /^(order:[ \t]*)\d+/m;

/**
 * Rewrites a draft's `order` in both the parsed doc and the top-level
 * `order:` line of the YAML text (the staged + committed artifact), leaving
 * any trailing comment intact.
 *
 * @param {string} yamlText
 * @param {object} doc
 * @param {number} order
 * @returns {{yamlText: string, doc: object}}
 */
export function withLessonOrder(yamlText, doc, order) {
  if (!ORDER_LINE.test(yamlText)) {
    throw new Error("withLessonOrder: no top-level `order:` line found in draft YAML");
  }
  return { yamlText: yamlText.replace(ORDER_LINE, `$1${order}`), doc: { ...doc, order } };
}
