/**
 * Author prompt pack. The FIXED block (schema digest + l1.yaml exemplar +
 * pedagogy principles + licensing rules + v1 draft constraints) is
 * byte-stable across topics within a run — deliberately prompt-cache
 * friendly, and the bench harness freezes it for comparability. The
 * per-topic block carries the radar card and freshly fetched primary
 * sources.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LESSON_SCHEMA_VERSION } from "@guided-repl/protocol";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXEMPLAR_PATH = resolve(PKG_ROOT, "../../packages/guided-repl-lessons/lessons/l1.yaml");

/**
 * Concise digest of the protocol's lesson Zod schema (lessonSchema.js).
 * Kept in prose (not generated) so the fixed block stays byte-stable across
 * dependency bumps; the test suite asserts it stays in sync with the step
 * types the schema actually accepts.
 */
export const SCHEMA_DIGEST = `Lesson document schema (schemaVersion: ${LESSON_SCHEMA_VERSION}):
- top-level: schemaVersion, id, slug, title, track (guided|advanced|dev-basics),
  order (int), durationTargetSec (int), prereqs [lesson ids], snapshot {snapshotId},
  steps [...], fixtures {key: {path, kind: claudeStream|shellTranscript}},
  completion {assertionIds [step ids], next (lesson id or null)}
- step types: instruction {id, md} · promptBuilder {id, suggestions [{text,
  description?, branchId?}], slots?} · run {id, branches {branchId: {fixture,
  expectedPrompt, permissionMode, seedSnapshotId?, model?}}, pacing?} ·
  annotation {id, fixtureKey, anchor {ordinal, frameType, where?}, md} ·
  permissionPrompt {id, branches {allow, deny}} · quiz {id, question, options,
  answerIdx, explainMd?} · assertion {id, rule} · terminalDrill {id, expect,
  transcript} · capture {id, fields [name|email], purposeMd, optional?, consent?}
- assertion rules: file-contains {path, match} · file-exists {path} ·
  terminal-matches {match} · file-equals {path, content} · quiz {...} ·
  streamEvent {match} · quizCorrect {stepId} · userChoice {equals} ·
  diffTouchedOnly {paths} · drillPassed {stepId}
- every run branch's fixture key must exist in fixtures{}; every
  completion.assertionIds entry must reference an assertion or quiz step;
  every promptBuilder suggestion must match exactly one branch expectedPrompt.`;

export const PEDAGOGY_RULES = `Pedagogy principles (hard):
- 5-minute lesson: durationTargetSec <= 330.
- The run step has AT MOST 3 branches, and the branches are counterfactuals of
  one decision (e.g. vague vs constrained prompt) so learners feel the contrast.
- EXACTLY ONE assertion step; completion.assertionIds references it.
- Annotation anchors point at the teachable moment in the stream.
- Every prompt suggestion must be a prompt a real learner would type.`;

export const LICENSING_RULES = `Content & licensing rules (hard):
- Registry courses are RADAR, not raw material: they inform what to teach and
  typical sequencing. Never reproduce or closely paraphrase course content,
  regardless of license.
- All lesson expression must be ORIGINAL, grounded in the primary sources
  provided below (official docs, specs, release notes).
- Cite nothing verbatim longer than a short phrase; no personal data, no
  local filesystem paths, no emails, no API keys.`;

export const DRAFT_CONSTRAINTS = `Foundry v1 draft constraints (hard — the seeder can only synthesize these):
- track: advanced
- snapshot.snapshotId MUST be "<lessonId>-input" (self-contained seed; do not
  reference another lesson's output snapshot).
- run branches use only permissionMode "acceptEdits" or "plan" (plan branches
  get the standard author-gate treatment). No multiplan/merge structures.
- fixtures paths follow "fixtures/<lessonId>/<branchId>.json", kind claudeStream.
- Do not add annotation steps that anchor on tool_use frames you cannot
  guarantee (keep anchors to ordinal 1 of common frame types) — prefer
  instruction steps for commentary.`;

/**
 * Builds the byte-stable fixed block. Reads the l1.yaml exemplar verbatim.
 *
 * @param {{exemplarPath?: string}} [opts]
 * @returns {string}
 */
export function buildFixedBlock({ exemplarPath = EXEMPLAR_PATH } = {}) {
  const exemplar = readFileSync(exemplarPath, "utf8");
  return [
    "You are the Lesson Foundry author for guided-repl: 5-minute, hands-on,",
    "fixture-replayed Claude Code lessons. Draft ONE complete lesson YAML",
    "document for the topic given at the end.",
    "",
    SCHEMA_DIGEST,
    "",
    PEDAGOGY_RULES,
    "",
    LICENSING_RULES,
    "",
    DRAFT_CONSTRAINTS,
    "",
    "Exemplar — lesson l1 YAML, the house style to match (verbatim):",
    "```yaml",
    exemplar.trimEnd(),
    "```",
    "",
    "Respond with a single fenced ```yaml code block containing ONLY the new",
    "lesson document. No commentary outside the block.",
  ].join("\n");
}

/**
 * Per-topic block: radar card + freshly fetched primary sources.
 *
 * @param {{topic: string, whyNow?: string, suggestedTrack?: string}} card
 * @param {import("../sources/fetchers.js").SourceItem[]} [sourceItems] fetched primary sources
 * @returns {string}
 */
export function buildTopicBlock(card, sourceItems = []) {
  const sources = sourceItems.length
    ? sourceItems
        .map((s) => `- ${s.title}${s.date ? ` (${s.date})` : ""}\n  ${s.url}${s.body ? `\n  ${s.body}` : ""}`)
        .join("\n")
    : "(no fetched source excerpts — ground the lesson in well-established, primary-source-verifiable behavior only)";
  return [
    `Topic: ${card.topic}`,
    card.whyNow ? `Why now: ${card.whyNow}` : "",
    "",
    "Primary sources (fetched fresh — ground every claim here):",
    sources,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {string} fixedBlock
 * @param {string} topicBlock
 * @returns {string} the full author prompt
 */
export function buildAuthorPrompt(fixedBlock, topicBlock) {
  return `${fixedBlock}\n\n---\n\n${topicBlock}`;
}
