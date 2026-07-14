/**
 * Self-corpus lesson index for the overlap gate — the spec's "retrieval
 * scoped to self-knowledge only": a TF-IDF term index over our own lesson
 * YAML sources (titles, instruction/annotation/quiz markdown), no external
 * embeddings, no deps, keyless.
 *
 * Scoring: TF-IDF-weighted term coverage of the topic against each lesson —
 * the topic's tf·idf mass that the lesson's text covers, in [0, 1]. Rare
 * terms (high idf) dominate, so a topic is "covered" only when its
 * *distinctive* vocabulary already appears in a lesson; ubiquitous corpus
 * terms (claude, code, prompt...) barely move the score.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_LESSONS_DIR = resolve(PKG_ROOT, "../../packages/guided-repl-lessons/lessons");

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have how i if in into is it its of on or " +
    "that the their then there these they this to was we what when where which who will " +
    "with you your not no so do does did done can could should would about after before " +
    "up down out over under more most just than too very"
  ).split(" "),
);

/**
 * @param {string} text
 * @returns {string[]} lowercased alpha-numeric tokens, stopwords removed
 */
export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

/**
 * Flattens the learner-facing text of one parsed lesson doc: title/slug plus
 * instruction, annotation, quiz, promptBuilder, and capture copy.
 *
 * @param {object} doc parsed lesson YAML
 * @returns {string}
 */
export function extractLessonText(doc) {
  const parts = [doc.title ?? "", (doc.slug ?? "").replace(/-/g, " ")];
  for (const step of doc.steps ?? []) {
    if (step.md) parts.push(step.md);
    if (step.purposeMd) parts.push(step.purposeMd);
    if (step.type === "quiz") {
      parts.push(step.question, ...(step.options ?? []), step.explainMd ?? "");
    }
    if (step.type === "promptBuilder") {
      for (const s of step.suggestions ?? []) parts.push(s.text, s.description ?? "");
    }
    if (step.type === "run") {
      for (const branch of Object.values(step.branches ?? {})) parts.push(branch.expectedPrompt ?? "");
    }
  }
  return parts.join("\n");
}

/**
 * Builds the index over every lesson YAML in `lessonsDir`.
 *
 * @param {{lessonsDir?: string}} [opts]
 * @returns {{
 *   lessons: {id: string, title: string, terms: Set<string>}[],
 *   overlapScore: (topicText: string) => {score: number, nearestLessonId: string|null},
 * }}
 */
export function buildLessonIndex({ lessonsDir = DEFAULT_LESSONS_DIR } = {}) {
  const files = readdirSync(lessonsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  if (files.length === 0) throw new Error(`lessonIndex: no lesson YAML found in ${lessonsDir}`);

  const lessons = files.map((file) => {
    const doc = parseYaml(readFileSync(join(lessonsDir, file), "utf8"));
    return {
      id: doc.id ?? file,
      title: doc.title ?? file,
      terms: new Set(tokenize(extractLessonText(doc))),
    };
  });

  const n = lessons.length;
  /** @param {string} term smoothed idf over the lesson corpus */
  function idf(term) {
    const df = lessons.reduce((acc, l) => acc + (l.terms.has(term) ? 1 : 0), 0);
    return Math.log((n + 1) / (df + 0.5));
  }

  /**
   * @param {string} topicText
   * @returns {{score: number, nearestLessonId: string|null}}
   */
  function overlapScore(topicText) {
    const tokens = tokenize(topicText);
    if (tokens.length === 0) return { score: 0, nearestLessonId: null };

    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const weights = [...tf.entries()].map(([term, count]) => ({ term, w: count * idf(term) }));
    const total = weights.reduce((acc, { w }) => acc + w, 0);
    if (total <= 0) return { score: 0, nearestLessonId: null };

    let best = { score: 0, nearestLessonId: null };
    for (const lesson of lessons) {
      const covered = weights.reduce((acc, { term, w }) => acc + (lesson.terms.has(term) ? w : 0), 0);
      const score = covered / total;
      if (score > best.score || best.nearestLessonId === null) {
        best = { score, nearestLessonId: lesson.id };
      }
    }
    return best;
  }

  return { lessons, overlapScore };
}

/**
 * The mandatory overlap gate: rejects a topic whose distinctive vocabulary
 * is already covered by an existing lesson.
 *
 * @param {ReturnType<typeof buildLessonIndex>} index
 * @param {string} topicText
 * @param {number} threshold settings.overlapThreshold
 * @returns {{passed: boolean, score: number, nearestLessonId: string|null, reason?: string}}
 */
export function gateTopic(index, topicText, threshold) {
  const { score, nearestLessonId } = index.overlapScore(topicText);
  if (score >= threshold) {
    return {
      passed: false,
      score,
      nearestLessonId,
      reason: `overlap ${score.toFixed(2)} >= ${threshold} with lesson ${nearestLessonId}`,
    };
  }
  return { passed: true, score, nearestLessonId };
}
