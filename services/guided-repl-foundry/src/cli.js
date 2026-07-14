#!/usr/bin/env node
/**
 * foundry CLI.
 *
 *   foundry run   [--mode radar|idea] [--idea "<text>"] [--top-n N]
 *                 [--dry-run] [--out <dir>] [--runner local|e2b]
 *                 [--model-<role> <id>] [--llm-lint]
 *   foundry scout [--dry-run] [--out <dir>]        # radar spine, no authoring
 *   foundry draft --idea "<text>" [...]            # alias: run --mode idea
 *   foundry bench --role <role> --models a,b [...] # model lab (see bench.js)
 *   foundry queue                                  # open foundry:draft PRs
 *
 * Structural invariant: this process only ever WRITES BUNDLES to --out. It
 * never touches git, never pushes, never opens or merges PRs — the workflow
 * copies bundle files onto a branch and opens a *draft* PR; a human merging
 * that PR is the only publish path.
 */

import path from "node:path";
import process from "node:process";

import { loadConfig } from "./config.js";
import { createAgentClient } from "./agent/agentClient.js";
import { runPipeline } from "./run.js";
import { listQueue, formatQueue } from "./pr/queue.js";
import { createDryRunQueryImpl, createDryRunRunner, dryRunFetchSource } from "./dryrun.js";
import { ROLES } from "./config.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/**
 * @param {string[]} argv args after the command name
 * @returns {{command: string, mode: string, idea: string|null, topN: number|null, dryRun: boolean, out: string|null, runner: string, overrides: Record<string, string>, llmLint: boolean, role: string|null, models: string[], noSeed: boolean}}
 */
export function parseFoundryArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error("usage: foundry <run|scout|draft|bench|queue> [options]");

  const opts = {
    command,
    mode: "radar",
    idea: null,
    topN: null,
    dryRun: false,
    out: null,
    runner: "local",
    overrides: {},
    llmLint: false,
    role: null,
    models: [],
    noSeed: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === "--mode") {
      opts.mode = next();
      if (!["radar", "idea"].includes(opts.mode)) throw new Error(`--mode must be radar|idea, got "${opts.mode}"`);
    } else if (arg === "--idea") opts.idea = next();
    else if (arg === "--top-n") {
      opts.topN = Number(next());
      if (!Number.isInteger(opts.topN) || opts.topN < 0) throw new Error("--top-n must be a non-negative integer");
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out") opts.out = next();
    else if (arg === "--runner") {
      opts.runner = next();
      if (!["local", "e2b"].includes(opts.runner)) throw new Error(`--runner must be local|e2b, got "${opts.runner}"`);
    } else if (arg === "--llm-lint") opts.llmLint = true;
    else if (arg === "--role") opts.role = next();
    else if (arg === "--models") opts.models = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--no-seed") opts.noSeed = true;
    else if (arg.startsWith("--model-")) {
      const role = arg.slice("--model-".length);
      if (!ROLES.includes(role)) throw new Error(`unknown role in ${arg} (known: ${ROLES.join(", ")})`);
      opts.overrides[role] = next();
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (command === "draft") {
    opts.command = "run";
    opts.mode = "idea";
  }
  return opts;
}

/**
 * Runs the CLI. All boundaries injectable via `deps` for tests; --dry-run
 * swaps in the built-in fakes.
 *
 * @param {string[]} argv args after node+script
 * @param {object} [deps] {queryImpl, fetchImpl, fetchSourceImpl, runner, versionProvider, execImpl, now, foundryDir, log}
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? ((msg) => console.log(msg));
  let opts;
  try {
    opts = parseFoundryArgs(argv);
  } catch (err) {
    log(`foundry: ${err.message}`);
    return EXIT_USAGE;
  }

  try {
    const config = loadConfig(deps.foundryDir ? { foundryDir: deps.foundryDir } : {});

    if (opts.command === "queue") {
      const prs = await listQueue({ label: config.settings.labels.draft, execImpl: deps.execImpl });
      log(formatQueue(prs, config.settings.labels.draft));
      return EXIT_OK;
    }

    if (opts.command === "bench") {
      const { runBench } = await import("./bench/bench.js");
      return runBench({ opts, config, deps, log });
    }

    if (opts.command !== "run" && opts.command !== "scout") {
      log(`foundry: unknown command "${opts.command}"`);
      return EXIT_USAGE;
    }

    // --- assemble the boundary implementations ---
    const queryImpl = deps.queryImpl ?? (opts.dryRun ? createDryRunQueryImpl() : undefined);
    const agentClient = createAgentClient({
      ...(queryImpl ? { queryImpl } : {}),
      models: config.models,
      pricing: config.settings.pricing,
      overrides: opts.overrides,
      maxTurns: config.settings.authorMaxTurns,
    });

    let runner = deps.runner;
    let versionProvider = deps.versionProvider;
    if (!runner) {
      if (opts.dryRun) {
        runner = createDryRunRunner();
        versionProvider = () => runner.getVersion();
      } else if (opts.runner === "e2b") {
        const { createE2bRunner } = await import("guided-repl-seeder/src/runner/e2bRunner.js");
        runner = createE2bRunner();
        const version = await runner.getVersion();
        versionProvider = () => version;
      } else {
        const seedLib = await import("guided-repl-seeder/src/seedLib.js");
        runner = seedLib.defaultRunner;
        versionProvider = versionProvider ?? seedLib.getClaudeCodeVersion;
      }
    }

    const outDir = opts.out ?? path.join(process.cwd(), "foundry-out");
    const mode = opts.command === "scout" ? "radar" : opts.mode;
    const topN = opts.command === "scout" ? 0 : opts.topN;

    const result = await runPipeline({
      mode,
      idea: opts.idea,
      config,
      agentClient,
      runner,
      versionProvider,
      outDir,
      ...(topN !== null ? { topN } : {}),
      fetchSourceImpl: deps.fetchSourceImpl ?? (opts.dryRun ? dryRunFetchSource : undefined),
      fetchImpl: deps.fetchImpl,
      githubToken: process.env.GITHUB_TOKEN,
      llmLint: opts.llmLint,
      now: deps.now,
      log,
    });

    for (const card of result.cards) {
      log(`card: [${card.decision}] ${card.topic}${card.reason ? ` — ${card.reason}` : ""}`);
    }
    log(
      `foundry ${opts.command}: ${result.draftBundles.length} draft bundle(s)` +
        `${result.radarBundle ? " + radar bundle" : ""} → ${outDir} ($${result.totalCostUsd.toFixed(4)})`,
    );

    // Idea mode exists to produce a draft: surface failure loudly.
    if (mode === "idea" && result.draftBundles.length === 0) {
      const card = result.cards[0];
      log(`foundry: idea did not produce a draft (${card?.decision}: ${card?.reason ?? "unknown"})`);
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  } catch (err) {
    log(`foundry: ${err.message}`);
    return EXIT_FAILURE;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
