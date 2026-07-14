import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main, parseFoundryArgs, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../src/cli.js";
import { dryRunDraftYaml } from "../src/dryrun.js";

const NOW = () => new Date("2026-07-12T14:00:00Z");
const quiet = () => {};

function tmpOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foundry-e2e-"));
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

test("e2e radar --dry-run: full spine with built-in fakes, bundle layout", async () => {
  const out = tmpOut();
  const lines = [];
  try {
    const code = await main(["run", "--mode", "radar", "--dry-run", "--out", out], {
      now: NOW,
      log: (m) => lines.push(m),
    });
    assert.equal(code, EXIT_OK, lines.join("\n"));

    const entries = fs.readdirSync(out).sort();
    // 6 sources → 5 lesson cards (top-3 drafted) + 1 bench card; radar bundle.
    const draftDirs = entries.filter((e) => e.startsWith("draft-"));
    assert.equal(draftDirs.length, 3, `expected 3 draft bundles, got ${entries.join(", ")}`);
    assert.ok(entries.includes("radar-2026-07"));

    // Radar bundle records every decision, including bench + skipped.
    const radarMd = fs.readFileSync(path.join(out, "radar-2026-07/foundry/notes/2026-07/radar.md"), "utf8");
    assert.match(radarMd, /\| bench \| anthropic-news /);
    assert.match(radarMd, /drafted — PR bundle foundry\/draft-/);
    assert.match(radarMd, /skipped — beyond top-3/);

    // Radar bundle carries notes for all 6 sources + cursors + radar.md.
    const radarFiles = walk(path.join(out, "radar-2026-07"));
    assert.equal(radarFiles.filter((f) => f.startsWith("foundry/notes/2026-07/")).length, 7); // 6 notes + radar.md
    assert.ok(radarFiles.includes("foundry/state/cursors.json"));
    const cursors = JSON.parse(fs.readFileSync(path.join(out, "radar-2026-07/foundry/state/cursors.json"), "utf8"));
    assert.equal(Object.keys(cursors.sources).length, 6);

    // Each draft bundle is a complete PR working set.
    const orders = [];
    for (const d of draftDirs) {
      const files = walk(path.join(out, d));
      assert.ok(files.includes("meta.json") && files.includes("PR_BODY.md") && files.includes("provenance.json"), d);
      const meta = JSON.parse(fs.readFileSync(path.join(out, d, "meta.json"), "utf8"));
      assert.equal(meta.kind, "draft");
      assert.ok(meta.branchName.startsWith("foundry/draft-"));
      assert.deepEqual(meta.labels, ["foundry:draft"]);
      assert.ok(meta.files.some((f) => f.startsWith("packages/guided-repl-lessons/lessons/")));
      assert.ok(meta.files.includes("apps/guided-repl/public/fixtures/v1/lessons.json"));

      // The dry-run draft YAML hardcodes order: 9; the pipeline must rewrite
      // each draft to a corpus-unique order (l1–l8 → 9, 10, 11), not collide.
      const lessonRel = files.find((f) => f.startsWith("packages/guided-repl-lessons/lessons/") && f.endsWith(".yaml"));
      const orderLine = fs.readFileSync(path.join(out, d, lessonRel), "utf8").match(/^order:[ \t]*(\d+)/m);
      orders.push(Number(orderLine[1]));
    }
    orders.sort((a, b) => a - b);
    assert.deepEqual(orders, [9, 10, 11], "drafts get distinct corpus-unique orders");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("e2e radar with injected fakes: overlap gate + budget cap abort recorded in the radar bundle", async () => {
  const out = tmpOut();
  try {
    const topics = [
      "Evaluating RAG retrieval quality with golden questions",
      "Observability tracing for agent tool pipelines",
      "Vector database index tuning for embeddings",
      "ship a landing page with Claude Code", // near-duplicate of l1 → gated
    ];
    const scoutReply = [
      "One busy month.",
      "```json",
      JSON.stringify({
        cards: topics.map((t) => ({ topic: t, whyNow: "fresh developments", sources: ["https://example.com/x"] })),
      }),
      "```",
    ].join("\n");

    const queryImpl = async ({ role, prompt }) => {
      if (role === "scout") return { text: scoutReply, usage: { input_tokens: 1_000, output_tokens: 200 } };
      const topic = prompt.match(/^Topic: (.+)$/m)[1];
      // Big author usage: ~$4.53/draft on fable-5 → 3rd projected draft blows the $10 cap.
      return { text: `\`\`\`yaml\n${dryRunDraftYaml(topic)}\`\`\``, usage: { input_tokens: 300_000, output_tokens: 30_000 } };
    };
    const fetchSourceImpl = async (source) =>
      source.id === "hf-blog"
        ? [{ id: "one", title: "One item", url: "https://example.com/one", date: "2026-07-01" }]
        : [];
    const { createDryRunRunner } = await import("../src/dryrun.js");
    const runner = createDryRunRunner();

    const code = await main(["run", "--mode", "radar", "--out", out], {
      queryImpl,
      fetchSourceImpl,
      runner,
      versionProvider: () => "0.0.0-test (Claude Code)",
      now: NOW,
      log: quiet,
    });
    assert.equal(code, EXIT_OK);

    const radarMd = fs.readFileSync(path.join(out, "radar-2026-07/foundry/notes/2026-07/radar.md"), "utf8");
    assert.match(radarMd, /gated-out — overlap \d\.\d\d >= 0\.65 with lesson l1/);
    assert.match(radarMd, /over-budget — projected \$\d+\.\d\d > cap \$10/);
    assert.equal((radarMd.match(/\| drafted/g) ?? []).length, 2, radarMd);

    const draftDirs = fs.readdirSync(out).filter((e) => e.startsWith("draft-"));
    assert.equal(draftDirs.length, 2, "budget stops the 3rd draft");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("e2e idea --dry-run: single-topic spine, draft bundle only", async () => {
  const out = tmpOut();
  try {
    const code = await main(
      ["run", "--mode", "idea", "--idea", "Evaluating RAG retrieval quality", "--dry-run", "--out", out],
      { now: NOW, log: quiet },
    );
    assert.equal(code, EXIT_OK);
    const entries = fs.readdirSync(out);
    assert.equal(entries.filter((e) => e.startsWith("draft-")).length, 1);
    assert.ok(!entries.some((e) => e.startsWith("radar-")), "idea mode writes no radar bundle");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("e2e idea: overlap-gated idea fails loudly (exit 1)", async () => {
  const out = tmpOut();
  const lines = [];
  try {
    const code = await main(
      ["run", "--mode", "idea", "--idea", "ship a landing page with Claude Code", "--dry-run", "--out", out],
      { now: NOW, log: (m) => lines.push(m) },
    );
    assert.equal(code, EXIT_FAILURE);
    assert.match(lines.join("\n"), /gated-out/);
    assert.equal(fs.readdirSync(out).filter((e) => e.startsWith("draft-")).length, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("e2e scout: notes + radar bundle, zero authoring", async () => {
  const out = tmpOut();
  try {
    const code = await main(["scout", "--dry-run", "--out", out], { now: NOW, log: quiet });
    assert.equal(code, EXIT_OK);
    const entries = fs.readdirSync(out);
    assert.deepEqual(entries, ["radar-2026-07"]);
    const radarMd = fs.readFileSync(path.join(out, "radar-2026-07/foundry/notes/2026-07/radar.md"), "utf8");
    assert.match(radarMd, /skipped — beyond top-0/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("e2e draft alias and usage errors", async () => {
  const out = tmpOut();
  try {
    const alias = await main(["draft", "--idea", "Observability tracing for agents", "--dry-run", "--out", out], {
      now: NOW,
      log: quiet,
    });
    assert.equal(alias, EXIT_OK);
    assert.equal(fs.readdirSync(out).filter((e) => e.startsWith("draft-")).length, 1);

    assert.equal(await main([], { log: quiet }), EXIT_USAGE);
    assert.equal(await main(["run", "--mode", "bogus"], { log: quiet }), EXIT_USAGE);
    assert.equal(await main(["run", "--model-poet", "claude-haiku-4-5"], { log: quiet }), EXIT_USAGE);
    assert.equal(await main(["frobnicate"], { log: quiet }), EXIT_USAGE);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("parseFoundryArgs: model overrides and flags", () => {
  const opts = parseFoundryArgs([
    "run", "--mode", "idea", "--idea", "x", "--top-n", "2", "--dry-run",
    "--out", "/tmp/o", "--runner", "e2b", "--model-author", "claude-opus-4-8", "--llm-lint",
  ]);
  assert.equal(opts.mode, "idea");
  assert.equal(opts.topN, 2);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.runner, "e2b");
  assert.deepEqual(opts.overrides, { author: "claude-opus-4-8" });
  assert.equal(opts.llmLint, true);
});
