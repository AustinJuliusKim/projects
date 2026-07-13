/**
 * Scout stage: per registry source, fetch the delta since the cursor, make
 * one cheap model call (role: scout), and emit a source-note markdown file
 * plus zero-or-more Topic Radar cards. One dead feed degrades (recorded in
 * `errors`), never kills the run. All emitted text passes the redaction gate.
 */

import { z } from "zod";
import { fetchSource } from "../sources/fetchers.js";
import { filterNewItems } from "./cursors.js";
import { assertRedacted } from "../redaction.js";

const RadarCardSchema = z.object({
  topic: z.string().min(1),
  whyNow: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  suggestedTrack: z.enum(["guided", "advanced", "dev-basics"]).catch("advanced").default("advanced"),
});

const SCOUT_SYSTEM = `You are the Lesson Foundry scout for guided-repl, a 5-minute interactive
Claude Code lesson platform (tracks: prompting, plan mode, permission modes,
CLAUDE.md, model choice, debugging). Given fresh items from ONE watched
source, you write an institutional-memory note and propose lesson topics.

Respond with:
1. A concise markdown summary of what changed and why it matters for
   AI-education content (a few bullet points; no personal data, no local
   paths, no emails).
2. A fenced \`\`\`json code block containing {"cards": [...]} where each card is
   {"topic": "...", "whyNow": "...", "sources": ["url", ...],
    "suggestedTrack": "guided"|"advanced"|"dev-basics"}.
   Propose at most 2 cards; propose zero (empty array) when nothing merits a
   new lesson. Topics must be teachable in a 5-minute hands-on lesson.
   Registry courses inform WHAT to teach, never wording to reuse.`;

/**
 * @param {{id: string}} source
 * @param {import("../sources/fetchers.js").SourceItem[]} items
 */
function buildScoutPrompt(source, items) {
  const lines = items.slice(0, 20).map((item) => {
    const parts = [`- ${item.title}`, item.date ? `(${item.date})` : "", `\n  url: ${item.url}`];
    if (item.body) parts.push(`\n  excerpt: ${item.body.slice(0, 500)}`);
    return parts.join(" ");
  });
  return `Source: ${source.id}\nNew items since last run (${items.length}):\n\n${lines.join("\n")}`;
}

/**
 * Extracts the {"cards": [...]} payload from the scout's fenced json block.
 *
 * @param {string} text
 * @returns {object[]} raw card objects (empty when absent/unparseable)
 */
export function extractCards(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (!fenced) return [];
  try {
    const parsed = JSON.parse(fenced[1]);
    return Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch {
    return [];
  }
}

/** @param {Date} d */
function monthDir(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Runs the scout over every registry source.
 *
 * @param {object} opts
 * @param {{sources: object[]}} opts.sources parsed sources.yaml
 * @param {{sources: Record<string, object>}} opts.cursors cursor state (mutated copy returned)
 * @param {{complete: Function}} opts.agentClient
 * @param {typeof fetchSource} [opts.fetchSourceImpl] injected in tests
 * @param {typeof fetch} [opts.fetchImpl] passed to the default fetchSource
 * @param {string} [opts.githubToken]
 * @param {{overlapScore: (t: string) => {score: number, nearestLessonId: string|null}}} [opts.lessonIndex]
 *   when provided, cards are stamped with overlapScore/nearestLessonId
 * @param {() => Date} [opts.now]
 * @returns {Promise<{
 *   notes: {sourceId: string, path: string, markdown: string}[],
 *   cards: object[],
 *   cursors: {sources: Record<string, object>},
 *   errors: {sourceId: string, message: string}[],
 *   usage: {calls: number, costUsd: number},
 * }>}
 */
export async function runScout({
  sources,
  cursors,
  agentClient,
  fetchSourceImpl = fetchSource,
  fetchImpl = globalThis.fetch,
  githubToken,
  lessonIndex,
  now = () => new Date(),
}) {
  const notes = [];
  const cards = [];
  const errors = [];
  const itemsBySource = {};
  const nextCursors = { sources: { ...cursors.sources } };
  let calls = 0;
  let costUsd = 0;

  for (const source of sources.sources) {
    try {
      const items = await fetchSourceImpl(source, { fetchImpl, githubToken });
      const { newItems, state } = filterNewItems(nextCursors.sources[source.id] ?? {}, items, { now });
      nextCursors.sources[source.id] = state;
      if (newItems.length === 0) continue;
      itemsBySource[source.id] = newItems;

      const { text, costUsd: callCost } = await agentClient.complete({
        role: "scout",
        system: SCOUT_SYSTEM,
        prompt: buildScoutPrompt(source, newItems),
      });
      calls += 1;
      costUsd += callCost;

      const markdown = [
        `# ${source.id} — ${now().toISOString().slice(0, 10)}`,
        "",
        text.replace(/```json[\s\S]*?```/i, "").trim(),
        "",
        `_${newItems.length} new item(s)._`,
        "",
      ].join("\n");
      assertRedacted(markdown, `scout note for ${source.id}`);

      for (const raw of extractCards(text)) {
        const parsed = RadarCardSchema.safeParse(raw);
        if (!parsed.success) {
          errors.push({ sourceId: source.id, message: `dropped malformed radar card: ${parsed.error.issues[0].message}` });
          continue;
        }
        const card = {
          ...parsed.data,
          // benchTrigger sources watch the model landscape: their cards mean
          // "new model → run `foundry bench`", never a lesson draft.
          kind: source.benchTrigger ? "bench" : "lesson",
          sourceId: source.id,
        };
        if (lessonIndex) {
          const { score, nearestLessonId } = lessonIndex.overlapScore(card.topic);
          card.overlapScore = score;
          card.nearestLessonId = nearestLessonId;
        }
        assertRedacted(JSON.stringify(card), `radar card from ${source.id}`);
        cards.push(card);
      }

      notes.push({
        sourceId: source.id,
        path: `notes/${monthDir(now())}/${source.id}.md`,
        markdown,
      });
    } catch (err) {
      errors.push({ sourceId: source.id, message: err.message });
    }
  }

  return { notes, cards, cursors: nextCursors, errors, itemsBySource, usage: { calls, costUsd } };
}
