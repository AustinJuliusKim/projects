/**
 * The Foundry run spine, shared by both triggers:
 *
 *   radar: scout → overlap gate → budget-capped top-N author → validate/seed
 *          → draft bundle per topic + one radar bundle
 *   idea:  same spine minus scout — a single hand-picked topic.
 *
 * Every model/network/sandbox/gh boundary arrives injected; the CLI decides
 * whether those are live implementations, --dry-run fakes, or test fakes.
 * All budget numbers come from settings.yaml — never literals here.
 */

import { runScout } from "./scout/scout.js";
import { buildLessonIndex, gateTopic } from "./overlap/lessonIndex.js";
import { buildFixedBlock } from "./author/promptPack.js";
import { authorDraft } from "./author/author.js";
import { nextLessonOrder, withLessonOrder } from "./lessons/nextOrder.js";
import { validateDraft } from "./validate/validateDraft.js";
import { buildDraftBundle } from "./pr/draftBundle.js";
import { buildRadarBundle } from "./radar/radarBundle.js";
import { readCursors } from "./scout/cursors.js";
import { costForModel } from "./agent/pricing.js";

/** Conservative per-draft author estimate for the budget projection. */
export const AUTHOR_EST_USAGE = { input_tokens: 60_000, output_tokens: 8_000 };

/**
 * @param {object} opts
 * @param {"radar"|"idea"} opts.mode
 * @param {string} [opts.idea] required in idea mode
 * @param {object} opts.config loadConfig() result
 * @param {{complete: Function, modelForRole: Function}} opts.agentClient
 * @param {import("guided-repl-seeder/src/runner/runner.js").Runner} opts.runner
 * @param {() => string} opts.versionProvider
 * @param {string} opts.outDir bundles land here
 * @param {number} [opts.topN] override of settings.topN
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {Function} [opts.fetchSourceImpl]
 * @param {string} [opts.githubToken]
 * @param {boolean} [opts.llmLint]
 * @param {string} [opts.cursorsPath] defaults to <foundryDir>/state/cursors.json
 * @param {() => Date} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{draftBundles: object[], radarBundle: object|null, cards: object[], totalCostUsd: number, errors: object[]}>}
 */
export async function runPipeline({
  mode,
  idea,
  config,
  agentClient,
  runner,
  versionProvider,
  outDir,
  topN,
  fetchImpl,
  fetchSourceImpl,
  githubToken,
  llmLint = false,
  cursorsPath,
  now = () => new Date(),
  log = () => {},
}) {
  const { sources, settings, foundryDir } = config;
  const index = buildLessonIndex();
  const budgetCapUsd = settings.budgetCapUsd;
  const takeN = topN ?? settings.topN;

  let notes = [];
  let cursors = { sources: {} };
  let errors = [];
  let itemsBySource = {};
  let cards = [];
  let spentUsd = 0;
  let scoutUsage = { calls: 0, costUsd: 0 };
  const authorUsage = { drafts: 0, costUsd: 0 };

  if (mode === "radar") {
    cursors = readCursors(cursorsPath ?? `${foundryDir}/state/cursors.json`);
    const scout = await runScout({
      sources,
      cursors,
      agentClient,
      lessonIndex: index,
      now,
      ...(fetchSourceImpl ? { fetchSourceImpl } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      githubToken,
    });
    notes = scout.notes;
    cursors = scout.cursors;
    errors = scout.errors;
    itemsBySource = scout.itemsBySource;
    cards = scout.cards;
    scoutUsage = scout.usage;
    spentUsd += scout.usage.costUsd;
    log(`scout: ${notes.length} note(s), ${cards.length} card(s), ${errors.length} error(s), $${scout.usage.costUsd.toFixed(4)}`);
  } else if (mode === "idea") {
    if (!idea) throw new Error("idea mode requires --idea \"<topic>\"");
    const { score, nearestLessonId } = index.overlapScore(idea);
    cards = [
      {
        topic: idea,
        whyNow: "admin idea box",
        sources: [],
        suggestedTrack: "advanced",
        kind: "lesson",
        sourceId: "idea-box",
        overlapScore: score,
        nearestLessonId,
      },
    ];
  } else {
    throw new Error(`unknown mode "${mode}"`);
  }

  // --- decide: gate → rank by novelty → top-N within budget ---
  for (const card of cards) {
    if (card.kind === "bench") {
      card.decision = "bench";
      card.reason = "model announcement — run `foundry bench`";
    }
  }
  const lessonCards = cards.filter((c) => c.kind === "lesson");
  for (const card of lessonCards) {
    // Gate on the topic itself — mixing in whyNow prose dilutes the score
    // and lets near-duplicates slip under the threshold.
    const verdict = gateTopic(index, card.topic, settings.overlapThreshold);
    card.overlapScore = verdict.score;
    card.nearestLessonId = verdict.nearestLessonId;
    if (!verdict.passed) {
      card.decision = "gated-out";
      card.reason = verdict.reason;
    }
  }
  const candidates = lessonCards
    .filter((c) => !c.decision)
    .sort((a, b) => a.overlapScore - b.overlapScore);
  for (const card of candidates.slice(takeN)) {
    card.decision = "skipped";
    card.reason = `beyond top-${takeN}`;
  }

  // --- author + validate + bundle, aborting on the budget cap ---
  const authorModel = agentClient.modelForRole("author");
  const estimatePerDraft = costForModel(AUTHOR_EST_USAGE, authorModel, settings.pricing);
  const fixedBlock = buildFixedBlock();
  const draftBundles = [];
  let budgetBlown = false;
  // The author copies the exemplar's order (1); assign corpus-unique orders,
  // distinct across drafts in this run so co-merged PRs don't collide.
  let nextOrder = nextLessonOrder();

  for (const card of candidates.slice(0, takeN)) {
    if (budgetBlown) {
      card.decision = "over-budget";
      card.reason = "authoring aborted by an earlier budget projection";
      continue;
    }
    const projected = spentUsd + estimatePerDraft;
    if (projected > budgetCapUsd) {
      budgetBlown = true;
      card.decision = "over-budget";
      card.reason = `projected $${projected.toFixed(2)} > cap $${budgetCapUsd}`;
      continue;
    }

    try {
      const sourceItems = itemsBySource[card.sourceId] ?? [];
      const draft = await authorDraft({ agentClient, card, sourceItems, fixedBlock });
      Object.assign(draft, withLessonOrder(draft.yamlText, draft.doc, nextOrder++));
      spentUsd += draft.provenance.costUsd;
      authorUsage.drafts += 1;
      authorUsage.costUsd += draft.provenance.costUsd;

      const validation = await validateDraft({
        doc: draft.doc,
        yamlText: draft.yamlText,
        runner,
        versionProvider,
        ...(llmLint ? { agentClient, llmLintEnabled: true } : {}),
      });
      if (validation.report.llmLint) spentUsd += validation.report.llmLint.costUsd;

      if (validation.schemaPass && validation.seedPass) {
        const bundle = buildDraftBundle({
          doc: draft.doc,
          yamlText: draft.yamlText,
          provenance: draft.provenance,
          validation,
          card,
          settings,
          outDir,
          now,
        });
        draftBundles.push(bundle);
        card.decision = "drafted";
        card.reason = `PR bundle ${bundle.branchName}`;
        log(`drafted ${draft.doc.id}: ${card.topic} ($${draft.provenance.costUsd.toFixed(4)})`);
      } else {
        const failures = [
          validation.report.schema.error,
          ...validation.report.lint.failures.map((f) => f.message),
          validation.report.seed.error,
          ...validation.report.seed.branches.filter((b) => !b.pass).map((b) => `${b.branchId}: ${b.detail}`),
          validation.report.compile.error,
          ...validation.report.redaction.leaks.map((l) => `${l.where}: ${l.name}`),
        ].filter(Boolean);
        card.decision = "draft-failed";
        card.reason = failures.slice(0, 3).join("; ") || "validation failed";
      }
    } catch (err) {
      card.decision = "draft-failed";
      card.reason = err.message;
    }
  }

  // --- radar/state bundle (radar mode records everything, always) ---
  let radarBundle = null;
  if (mode === "radar") {
    radarBundle = buildRadarBundle({
      notes,
      cards,
      cursors,
      errors,
      settings,
      outDir,
      usage: { scout: scoutUsage, author: authorUsage, totalUsd: spentUsd },
      now,
    });
  }

  return { draftBundles, radarBundle, cards, totalCostUsd: spentUsd, errors };
}
