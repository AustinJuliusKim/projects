import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runScout, extractCards } from "../src/scout/scout.js";
import { filterNewItems, itemHash, readCursors, MAX_SEEN_HASHES } from "../src/scout/cursors.js";
import { createAgentClient } from "../src/agent/agentClient.js";
import { loadConfig } from "../src/config.js";
import { buildLessonIndex } from "../src/overlap/lessonIndex.js";
import { createFakeAgent } from "./fakes/fakeAgent.js";
import { createFakeFetch } from "./fakes/fakeFetch.js";

const { models, settings } = loadConfig();
const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const NOW = () => new Date("2026-07-12T14:00:00Z");

const SOURCES = {
  sources: [
    { id: "claude-code-releases", method: "githubReleases", repo: "anthropics/claude-code", cadence: "monthly", benchTrigger: false },
    { id: "hf-blog", method: "rss", url: "https://huggingface.co/blog/feed.xml", cadence: "monthly", benchTrigger: false },
    { id: "anthropic-news", method: "rss", url: "https://www.anthropic.com/news/rss.xml", cadence: "monthly", benchTrigger: true },
    { id: "dead-feed", method: "rss", url: "https://dead.example.com/feed.xml", cadence: "monthly", benchTrigger: false },
  ],
};

const SCOUT_REPLY = [
  "Fresh releases worth teaching.",
  "```json",
  JSON.stringify({
    cards: [
      { topic: "Evaluating RAG retrieval quality", whyNow: "New tooling landed this month", sources: ["https://huggingface.co/blog/rag-eval-open-judges"], suggestedTrack: "advanced" },
    ],
  }),
  "```",
].join("\n");

const BENCH_REPLY = [
  "A new model shipped.",
  "```json",
  JSON.stringify({
    cards: [
      { topic: "New model: Claude Sonnet 5", whyNow: "Model announcement — run foundry bench", sources: ["https://www.anthropic.com/news/claude-sonnet-5"] },
    ],
  }),
  "```",
].join("\n");

function makeDeps({ byRoleReplies }) {
  const { fetchImpl } = createFakeFetch({
    "https://api.github.com/repos/anthropics/claude-code/releases": JSON.parse(fixture("github-releases.json")),
    "https://huggingface.co/blog/feed.xml": fixture("hf-blog.rss.xml"),
    "https://www.anthropic.com/news/rss.xml": fixture("anthropic-news.rss.xml"),
    // dead-feed intentionally unrouted → 404
  });
  const fake = createFakeAgent({ responses: byRoleReplies });
  const agentClient = createAgentClient({ queryImpl: fake.queryImpl, models, pricing: settings.pricing });
  return { fetchImpl, agentClient, fake };
}

test("scout: notes + cards per source, bench kind from benchTrigger, dead feed degrades", async () => {
  const { fetchImpl, agentClient } = makeDeps({ byRoleReplies: [SCOUT_REPLY, SCOUT_REPLY, BENCH_REPLY] });
  const result = await runScout({
    sources: SOURCES,
    cursors: { sources: {} },
    agentClient,
    fetchImpl,
    lessonIndex: buildLessonIndex(),
    now: NOW,
  });

  // 3 live sources produced notes; the dead feed is isolated into errors.
  assert.deepEqual(result.notes.map((n) => n.sourceId), ["claude-code-releases", "hf-blog", "anthropic-news"]);
  assert.equal(result.notes[0].path, "notes/2026-07/claude-code-releases.md");
  assert.match(result.notes[0].markdown, /Fresh releases/);
  assert.ok(!result.notes[0].markdown.includes("```json"), "json block stripped from the note");

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].sourceId, "dead-feed");
  assert.match(result.errors[0].message, /HTTP 404/);

  const kinds = new Map(result.cards.map((c) => [c.sourceId, c.kind]));
  assert.equal(kinds.get("anthropic-news"), "bench");
  assert.equal(kinds.get("hf-blog"), "lesson");

  // Cards got overlap-stamped against the real corpus.
  for (const card of result.cards) {
    assert.ok(typeof card.overlapScore === "number" && card.overlapScore >= 0 && card.overlapScore <= 1);
  }
  assert.equal(result.usage.calls, 3);
  assert.ok(result.usage.costUsd > 0);
});

test("scout: cursor dedupe makes an immediate re-run a no-op (unmerged state PR)", async () => {
  const first = makeDeps({ byRoleReplies: [SCOUT_REPLY, SCOUT_REPLY, BENCH_REPLY] });
  const run1 = await runScout({ sources: SOURCES, cursors: { sources: {} }, agentClient: first.agentClient, fetchImpl: first.fetchImpl, now: NOW });

  const second = makeDeps({ byRoleReplies: [] });
  const run2 = await runScout({ sources: SOURCES, cursors: run1.cursors, agentClient: second.agentClient, fetchImpl: second.fetchImpl, now: NOW });

  assert.equal(run2.notes.length, 0, "everything already summarized");
  assert.equal(run2.cards.length, 0);
  assert.equal(second.fake.calls.length, 0, "no model calls on a clean re-run");
});

test("scout: redaction leak in emitted markdown fails that source, not the run", async () => {
  const leaky = "Summary mentioning /Users/aukim/secrets\n```json\n{\"cards\": []}\n```";
  const { fetchImpl, agentClient } = makeDeps({ byRoleReplies: [leaky, SCOUT_REPLY, BENCH_REPLY] });
  const result = await runScout({ sources: SOURCES, cursors: { sources: {} }, agentClient, fetchImpl, now: NOW });

  const errorIds = result.errors.map((e) => e.sourceId);
  assert.ok(errorIds.includes("claude-code-releases"));
  assert.match(result.errors.find((e) => e.sourceId === "claude-code-releases").message, /redaction/);
  // Later sources still produced notes.
  assert.ok(result.notes.some((n) => n.sourceId === "hf-blog"));
});

test("scout: malformed cards are dropped and recorded, valid ones kept", async () => {
  const mixed = [
    "note",
    "```json",
    JSON.stringify({ cards: [{ whyNow: "missing topic", sources: ["https://x.example"] }, { topic: "Valid topic here", whyNow: "ok", sources: ["https://x.example"] }] }),
    "```",
  ].join("\n");
  const { fetchImpl, agentClient } = makeDeps({ byRoleReplies: [mixed, SCOUT_REPLY, BENCH_REPLY] });
  const result = await runScout({ sources: SOURCES, cursors: { sources: {} }, agentClient, fetchImpl, now: NOW });

  assert.ok(result.errors.some((e) => e.message.includes("malformed radar card")));
  assert.ok(result.cards.some((c) => c.topic === "Valid topic here"));
});

test("extractCards tolerates missing/broken json blocks", () => {
  assert.deepEqual(extractCards("no block at all"), []);
  assert.deepEqual(extractCards("```json\n{broken\n```"), []);
  assert.deepEqual(extractCards("```json\n{\"cards\": \"nope\"}\n```"), []);
});

test("cursors: content-hash dedupe and hash-cap pruning", () => {
  const items = [
    { id: "a", title: "A", date: "1" },
    { id: "b", title: "B", date: "2" },
  ];
  const first = filterNewItems({}, items, { now: NOW });
  assert.equal(first.newItems.length, 2);
  const again = filterNewItems(first.state, items, { now: NOW });
  assert.equal(again.newItems.length, 0, "idempotent re-run");

  // Changed content re-triggers (hash covers title/date, not just id).
  const changed = filterNewItems(first.state, [{ id: "a", title: "A v2", date: "3" }], { now: NOW });
  assert.equal(changed.newItems.length, 1);
  assert.notEqual(itemHash(items[0]), itemHash(changed.newItems[0]));

  const many = Array.from({ length: MAX_SEEN_HASHES + 50 }, (_, i) => ({ id: `i${i}`, title: `t${i}` }));
  const capped = filterNewItems({}, many, { now: NOW });
  assert.equal(capped.state.seenHashes.length, MAX_SEEN_HASHES);
});

test("cursors: readCursors of the committed state file", () => {
  const state = readCursors(fileURLToPath(new URL("../../../foundry/state/cursors.json", import.meta.url)));
  assert.deepEqual(state, { sources: {} });
});
