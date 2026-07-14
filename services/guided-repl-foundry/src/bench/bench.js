/**
 * Model Lab (`foundry bench`): role × model matrix over the frozen golden
 * sets in foundry/bench/golden/ — never live-fetched, so sweeps stay
 * comparable across models and time.
 *
 * Author metrics: schema-pass %, seed-pass % (reuses validateDraft — the
 * un-gameable signal), judge pairwise wins (fixed judge, never a
 * contestant), $/draft, latency. Scout metrics: topic recall/precision vs
 * hand-labeled snapshots, $/run. Scorecards land in foundry/bench/results/.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { createAgentClient } from "../agent/agentClient.js";
import { buildFixedBlock } from "../author/promptPack.js";
import { authorDraft } from "../author/author.js";
import { nextLessonOrder, withLessonOrder } from "../lessons/nextOrder.js";
import { validateDraft } from "../validate/validateDraft.js";
import { SCOUT_SYSTEM, buildScoutPrompt, extractCards } from "../scout/scout.js";
import { judgePair } from "./judges.js";
import { createDryRunRunner } from "../dryrun.js";
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../cli.js";

/** Parses one golden author brief (markdown with YAML frontmatter). */
export function parseBrief(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("golden brief has no YAML frontmatter");
  const meta = parseYaml(m[1]);
  for (const key of ["id", "topic", "sources"]) {
    if (!meta[key]) throw new Error(`golden brief missing "${key}"`);
  }
  return meta;
}

/** @param {string} dir */
function loadAuthorBriefs(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseBrief(fs.readFileSync(path.join(dir, f), "utf8")));
}

/** @param {string} dir */
function loadScoutSnapshots(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

/** Does a predicted topic match an expected label (all keywords present)? */
function topicMatches(topic, expected) {
  const t = topic.toLowerCase();
  return expected.keywords.every((k) => t.includes(k.toLowerCase()));
}

/**
 * Author sweep: model × brief.
 *
 * @param {object} opts
 * @returns {Promise<{perModel: Record<string, object>, judge: {model: string, decisions: object[]}}>}
 */
export async function benchAuthor({ contestants, briefs, agentClient, judgeModel, runner, versionProvider, noSeed, log }) {
  const fixedBlock = buildFixedBlock();
  // Corpus-unique order so seed-pass % isn't skewed by order collisions;
  // each draft compiles in its own staging dir, so one shared value suffices.
  const benchOrder = nextLessonOrder();
  /** drafts[briefId][model] = {model, yamlText, doc} */
  const drafts = {};
  const perModel = Object.fromEntries(
    contestants.map((m) => [
      m,
      { model: m, briefs: briefs.length, schemaPass: 0, seedPass: 0, seedRuns: 0, judgeWins: 0, costUsd: 0, latencyMs: 0 },
    ]),
  );

  for (const brief of briefs) {
    drafts[brief.id] = {};
    for (const model of contestants) {
      const stats = perModel[model];
      const started = Date.now();
      try {
        const draft = await authorDraft({
          agentClient,
          card: { topic: brief.topic, whyNow: brief.whyNow },
          sourceItems: brief.sources,
          fixedBlock,
          model,
        });
        Object.assign(draft, withLessonOrder(draft.yamlText, draft.doc, benchOrder));
        stats.latencyMs += Date.now() - started;
        stats.costUsd += draft.provenance.costUsd;
        stats.schemaPass += 1;
        drafts[brief.id][model] = draft;

        if (!noSeed) {
          stats.seedRuns += 1;
          const validation = await validateDraft({ doc: draft.doc, yamlText: draft.yamlText, runner, versionProvider });
          if (validation.seedPass) stats.seedPass += 1;
        }
      } catch (err) {
        stats.latencyMs += Date.now() - started;
        log(`bench: ${model} failed brief ${brief.id}: ${err.message}`);
      }
    }
  }

  // Pairwise judging per brief over drafts that passed schema.
  const decisions = [];
  for (const brief of briefs) {
    for (let i = 0; i < contestants.length; i++) {
      for (let j = i + 1; j < contestants.length; j++) {
        const a = drafts[brief.id][contestants[i]];
        const b = drafts[brief.id][contestants[j]];
        if (!a || !b) continue;
        const { winner } = await judgePair({
          agentClient,
          judgeModel,
          brief,
          a: { model: contestants[i], yamlText: a.yamlText },
          b: { model: contestants[j], yamlText: b.yamlText },
        });
        decisions.push({ brief: brief.id, a: contestants[i], b: contestants[j], winner });
        if (winner) perModel[winner].judgeWins += 1;
      }
    }
  }

  return { perModel, judge: { model: judgeModel, decisions } };
}

/**
 * Scout sweep: model × labeled snapshot → recall/precision.
 */
export async function benchScout({ contestants, snapshots, agentClient, log }) {
  const perModel = Object.fromEntries(
    contestants.map((m) => [m, { model: m, snapshots: snapshots.length, recall: 0, precision: 0, costUsd: 0 }]),
  );

  for (const model of contestants) {
    const stats = perModel[model];
    for (const snapshot of snapshots) {
      try {
        const { text, costUsd } = await agentClient.complete({
          role: "scout",
          model,
          system: SCOUT_SYSTEM,
          prompt: buildScoutPrompt(snapshot.source, snapshot.items),
        });
        stats.costUsd += costUsd;
        const topics = extractCards(text).map((c) => c.topic ?? "");
        const matched = snapshot.expected.filter((e) => topics.some((t) => topicMatches(t, e)));
        stats.recall += snapshot.expected.length ? matched.length / snapshot.expected.length : 1;
        stats.precision += topics.length
          ? topics.filter((t) => snapshot.expected.some((e) => topicMatches(t, e))).length / topics.length
          : 0;
      } catch (err) {
        log(`bench: scout ${model} failed snapshot ${snapshot.id}: ${err.message}`);
      }
    }
    stats.recall /= snapshots.length || 1;
    stats.precision /= snapshots.length || 1;
  }
  return { perModel };
}

/** @param {number} n @param {number} d */
function pct(n, d) {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

/** Renders the author scorecard markdown. */
export function renderAuthorScorecard({ role, date, perModel, judge, briefs }) {
  const rows = Object.values(perModel).map((s) => {
    const avgCost = s.schemaPass ? (s.costUsd / s.schemaPass).toFixed(4) : "n/a";
    const avgLatency = s.briefs ? Math.round(s.latencyMs / s.briefs) : 0;
    return `| ${s.model} | ${pct(s.schemaPass, s.briefs)} | ${pct(s.seedPass, s.seedRuns)} | ${s.judgeWins} | $${avgCost} | ${avgLatency} |`;
  });
  const judged = judge.decisions.map((d) => `- ${d.brief}: ${d.a} vs ${d.b} → ${d.winner ?? "no verdict"}`);
  return `# Bench — ${role} — ${date}

Judge: ${judge.model} (fixed; never a contestant). Golden briefs: ${briefs.length}.

| model | schema-pass | seed-pass | judge wins | $/draft | latency ms |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Pairwise decisions

${judged.join("\n") || "- (none)"}
`;
}

/** Renders the scout scorecard markdown. */
export function renderScoutScorecard({ date, perModel }) {
  const rows = Object.values(perModel).map(
    (s) => `| ${s.model} | ${(s.recall * 100).toFixed(0)}% | ${(s.precision * 100).toFixed(0)}% | $${s.costUsd.toFixed(4)} |`,
  );
  return `# Bench — scout — ${date}

| model | topic recall | precision | $/run |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
}

/**
 * CLI entry (`foundry bench`). Boundaries via deps: {queryImpl, runner,
 * versionProvider, resultsDir, goldenDir, now}.
 *
 * @returns {Promise<number>} exit code
 */
export async function runBench({ opts, config, deps = {}, log }) {
  const role = opts.role ?? "author";
  if (!["author", "scout"].includes(role)) {
    log(`foundry bench: --role must be author|scout, got "${role}"`);
    return EXIT_USAGE;
  }

  const roleCfg = config.models.roles[role];
  const contestants = opts.models.length ? opts.models : [roleCfg.model, ...roleCfg.benchCandidates];
  const judgeModel = config.models.roles.judge.model;
  if (contestants.includes(judgeModel)) {
    log(`foundry bench: judge model ${judgeModel} is a contestant — judge hygiene forbids self-judging; pick different --models`);
    return EXIT_FAILURE;
  }

  const agentClient = createAgentClient({
    ...(deps.queryImpl ? { queryImpl: deps.queryImpl } : {}),
    models: config.models,
    pricing: config.settings.pricing,
    maxTurns: config.settings.authorMaxTurns,
  });
  const goldenDir = deps.goldenDir ?? path.join(config.foundryDir, "bench/golden");
  const resultsDir = deps.resultsDir ?? path.join(config.foundryDir, "bench/results");
  const now = deps.now ?? (() => new Date());
  const date = now().toISOString().slice(0, 10);

  let result;
  let markdown;
  if (role === "author") {
    const briefs = loadAuthorBriefs(path.join(goldenDir, "author"));
    const runner = deps.runner ?? (opts.dryRun ? createDryRunRunner() : undefined);
    if (!runner && !opts.noSeed) {
      log("foundry bench: seed-pass needs a runner — pass --no-seed, --dry-run, or run with an injected runner");
      return EXIT_USAGE;
    }
    result = await benchAuthor({
      contestants,
      briefs,
      agentClient,
      judgeModel,
      runner,
      versionProvider: deps.versionProvider ?? (() => runner?.getVersion?.() ?? "unknown"),
      noSeed: opts.noSeed,
      log,
    });
    markdown = renderAuthorScorecard({ role, date, perModel: result.perModel, judge: result.judge, briefs });
  } else {
    const snapshots = loadScoutSnapshots(path.join(goldenDir, "scout"));
    result = await benchScout({ contestants, snapshots, agentClient, log });
    markdown = renderScoutScorecard({ date, perModel: result.perModel });
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  const base = path.join(resultsDir, `${date}-${role}`);
  fs.writeFileSync(`${base}.md`, markdown);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify({ role, date, contestants, judgeModel, ...result }, null, 2)}\n`);
  log(`foundry bench: wrote ${base}.md`);
  return EXIT_OK;
}
