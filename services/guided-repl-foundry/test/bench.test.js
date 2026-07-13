import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBench, parseBrief } from "../src/bench/bench.js";
import { parseJudgeVerdict, buildJudgePrompt } from "../src/bench/judges.js";
import { loadConfig } from "../src/config.js";
import { dryRunDraftYaml, createDryRunRunner } from "../src/dryrun.js";
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../src/cli.js";

const config = loadConfig();
const NOW = () => new Date("2026-07-12T14:00:00Z");
const quiet = () => {};

function benchOpts(extra = {}) {
  return { role: "author", models: [], dryRun: false, noSeed: false, ...extra };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foundry-bench-"));
}

test("author bench: matrix over the committed golden briefs, scorecard written", async () => {
  const resultsDir = tmpDir();
  const judgeCalls = [];
  // opus drafts fine; sonnet-5 returns garbage twice per brief → schema fail.
  const queryImpl = async ({ role, model, prompt }) => {
    if (role === "judge") {
      judgeCalls.push({ model, prompt });
      return { text: "Reasoning...\nWINNER: A", usage: { input_tokens: 5_000, output_tokens: 200 } };
    }
    if (model === "claude-sonnet-5") return { text: "not yaml at all", usage: { input_tokens: 1_000, output_tokens: 50 } };
    const topic = prompt.match(/^Topic: (.+)$/m)[1];
    return { text: `\`\`\`yaml\n${dryRunDraftYaml(topic)}\`\`\``, usage: { input_tokens: 50_000, output_tokens: 4_000 } };
  };

  try {
    const code = await runBench({
      opts: benchOpts({ models: ["claude-opus-4-8", "claude-sonnet-5"] }),
      config,
      deps: { queryImpl, runner: createDryRunRunner(), versionProvider: () => "0.0.0-test", resultsDir, now: NOW },
      log: quiet,
    });
    assert.equal(code, EXIT_OK);

    const json = JSON.parse(fs.readFileSync(path.join(resultsDir, "2026-07-12-author.json"), "utf8"));
    assert.deepEqual(json.contestants, ["claude-opus-4-8", "claude-sonnet-5"]);
    assert.equal(json.judgeModel, "claude-sonnet-4-6");

    const opus = json.perModel["claude-opus-4-8"];
    assert.equal(opus.briefs, 3, "three committed golden briefs");
    assert.equal(opus.schemaPass, 3);
    assert.equal(opus.seedPass, 3, "dry-run runner satisfies the drafts' own assertions");
    assert.ok(opus.costUsd > 0);

    const sonnet = json.perModel["claude-sonnet-5"];
    assert.equal(sonnet.schemaPass, 0);
    assert.equal(sonnet.seedRuns, 0, "no seed spend on schema-failed drafts");

    // No pairwise judging happened (one side always failed schema).
    assert.equal(json.judgeModel === "claude-sonnet-4-6" && json.perModel["claude-opus-4-8"].judgeWins, 0);
    assert.equal(judgeCalls.length, 0);

    const md = fs.readFileSync(path.join(resultsDir, "2026-07-12-author.md"), "utf8");
    assert.match(md, /\| model \| schema-pass \| seed-pass \| judge wins \| \$\/draft \| latency ms \|/);
    assert.match(md, /claude-opus-4-8 \| 100% \| 100% \|/);
    assert.match(md, /claude-sonnet-5 \| 0% \| n\/a \|/);
    assert.match(md, /Judge: claude-sonnet-4-6 \(fixed; never a contestant\)/);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test("author bench: pairwise judging tallies wins when both sides pass schema", async () => {
  const resultsDir = tmpDir();
  const queryImpl = async ({ role, prompt }) => {
    if (role === "judge") return { text: "WINNER: B", usage: { input_tokens: 4_000, output_tokens: 100 } };
    const topic = prompt.match(/^Topic: (.+)$/m)[1];
    return { text: `\`\`\`yaml\n${dryRunDraftYaml(topic)}\`\`\``, usage: { input_tokens: 40_000, output_tokens: 3_000 } };
  };
  try {
    const code = await runBench({
      opts: benchOpts({ models: ["claude-fable-5", "claude-opus-4-8"], noSeed: true }),
      config,
      deps: { queryImpl, resultsDir, now: NOW },
      log: quiet,
    });
    assert.equal(code, EXIT_OK);
    const json = JSON.parse(fs.readFileSync(path.join(resultsDir, "2026-07-12-author.json"), "utf8"));
    // "B" is the second contestant in every pair → opus sweeps all 3 briefs.
    assert.equal(json.perModel["claude-opus-4-8"].judgeWins, 3);
    assert.equal(json.perModel["claude-fable-5"].judgeWins, 0);
    assert.equal(json.judgeModel, "claude-sonnet-4-6");
    assert.equal(json.perModel["claude-fable-5"].seedRuns, 0, "--no-seed skips seeding");
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test("judge hygiene: a contestant equal to the judge model is an error", async () => {
  const code = await runBench({
    opts: benchOpts({ models: ["claude-sonnet-4-6", "claude-opus-4-8"], noSeed: true }),
    config,
    deps: {},
    log: quiet,
  });
  assert.equal(code, EXIT_FAILURE);
});

test("scout bench: recall/precision against the labeled snapshot", async () => {
  const resultsDir = tmpDir();
  // haiku finds both labeled topics + one noise card; sonnet-5 finds one.
  const queryImpl = async ({ model }) => {
    const cards =
      model === "claude-haiku-4-5"
        ? [
            { topic: "Evaluating RAG retrieval quality", whyNow: "x", sources: ["https://x"] },
            { topic: "Local fine-tuning on a laptop", whyNow: "x", sources: ["https://x"] },
            { topic: "Office party recap", whyNow: "x", sources: ["https://x"] },
          ]
        : [{ topic: "RAG retrieval evals", whyNow: "x", sources: ["https://x"] }];
    return {
      text: `note\n\`\`\`json\n${JSON.stringify({ cards })}\n\`\`\``,
      usage: { input_tokens: 2_000, output_tokens: 300 },
    };
  };
  try {
    const code = await runBench({
      opts: benchOpts({ role: "scout", models: ["claude-haiku-4-5", "claude-sonnet-5"] }),
      config,
      deps: { queryImpl, resultsDir, now: NOW },
      log: quiet,
    });
    assert.equal(code, EXIT_OK);
    const json = JSON.parse(fs.readFileSync(path.join(resultsDir, "2026-07-12-scout.json"), "utf8"));
    const haiku = json.perModel["claude-haiku-4-5"];
    assert.equal(haiku.recall, 1, "both labels matched");
    assert.ok(Math.abs(haiku.precision - 2 / 3) < 1e-9, "one noise card");
    const sonnet = json.perModel["claude-sonnet-5"];
    assert.equal(sonnet.recall, 0.5);
    assert.equal(sonnet.precision, 1);
    const md = fs.readFileSync(path.join(resultsDir, "2026-07-12-scout.md"), "utf8");
    assert.match(md, /claude-haiku-4-5 \| 100% \| 67% \|/);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test("bench usage errors: bad role, missing runner without --no-seed", async () => {
  assert.equal(await runBench({ opts: benchOpts({ role: "poet" }), config, deps: {}, log: quiet }), EXIT_USAGE);
  assert.equal(
    await runBench({ opts: benchOpts({ models: ["claude-opus-4-8"] }), config, deps: {}, log: quiet }),
    EXIT_USAGE,
  );
});

test("golden briefs parse and stay frozen-shaped; judge helpers behave", () => {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../foundry/bench/golden/author");
  const briefs = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(briefs.length >= 3 && briefs.length <= 5, "3-5 frozen briefs");
  for (const f of briefs) {
    const brief = parseBrief(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.ok(brief.id && brief.topic && brief.sources.length >= 1, f);
    for (const s of brief.sources) assert.ok(s.title && s.url, `${f} source pack complete`);
  }

  assert.equal(parseJudgeVerdict("blah\nWINNER: A"), "A");
  assert.equal(parseJudgeVerdict("winner: b"), "B");
  assert.equal(parseJudgeVerdict("no verdict here"), null);
  const prompt = buildJudgePrompt({ topic: "T" }, "a: 1\n", "b: 2\n");
  assert.match(prompt, /--- DRAFT A ---[\s\S]*a: 1[\s\S]*--- DRAFT B ---[\s\S]*b: 2/);
});
