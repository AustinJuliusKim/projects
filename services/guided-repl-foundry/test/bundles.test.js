import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { buildDraftBundle } from "../src/pr/draftBundle.js";
import { buildRadarBundle } from "../src/radar/radarBundle.js";
import { listQueue, formatQueue } from "../src/pr/queue.js";
import { validateDraft } from "../src/validate/validateDraft.js";
import { findRedactionLeaks } from "../src/redaction.js";
import { loadConfig } from "../src/config.js";
import { createFakeRunner, makeDraftScript } from "guided-repl-seeder/test/fakes/fakeRunner.js";

const { settings } = loadConfig();
const YAML_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/valid-draft.yaml", import.meta.url)), "utf8");
const NOW = () => new Date("2026-07-12T14:00:00Z");
const PROVENANCE = {
  role: "author",
  model: "claude-fable-5",
  costUsd: 0.5123,
  tokens: { input_tokens: 40_000, output_tokens: 2_000 },
  attempts: 1,
};
const CARD = {
  topic: "Evaluating RAG retrieval quality",
  whyNow: "New eval tooling this month",
  sources: ["https://huggingface.co/blog/rag-eval-open-judges"],
  overlapScore: 0.21,
  nearestLessonId: "l6",
};

function tmpOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foundry-bundle-test-"));
}

/** Recursively collect files under a dir. */
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

async function makeValidation() {
  const runner = createFakeRunner(makeDraftScript());
  return validateDraft({
    doc: parseYaml(YAML_TEXT),
    yamlText: YAML_TEXT,
    runner,
    versionProvider: () => "9.9.9 (Claude Code)",
  });
}

test("draft bundle: full PR working set, review card, provenance — no git, no leaks", async () => {
  const validation = await makeValidation();
  const outDir = tmpOut();
  try {
    const bundle = buildDraftBundle({
      doc: parseYaml(YAML_TEXT),
      yamlText: YAML_TEXT,
      provenance: PROVENANCE,
      validation,
      card: CARD,
      settings,
      outDir,
      now: NOW,
    });

    assert.equal(bundle.branchName, "foundry/draft-l9-20260712");
    assert.deepEqual(bundle.labels, ["foundry:draft"]);

    const all = walk(bundle.dir);
    assert.deepEqual(
      all.sort(),
      [
        "PR_BODY.md",
        "apps/guided-repl/public/fixtures/v1/fixtures/l9/eyeball.json",
        "apps/guided-repl/public/fixtures/v1/fixtures/l9/measure.json",
        "apps/guided-repl/public/fixtures/v1/lessons.json",
        "apps/guided-repl/public/fixtures/v1/snapshots/l9-input.json",
        "meta.json",
        "packages/guided-repl-lessons/lessons/l9.yaml",
        "provenance.json",
      ],
    );

    const meta = JSON.parse(fs.readFileSync(path.join(bundle.dir, "meta.json"), "utf8"));
    assert.equal(meta.kind, "draft");
    assert.equal(meta.branchName, bundle.branchName);
    assert.equal(meta.prBodyFile, "PR_BODY.md");
    assert.ok(meta.files.every((f) => !f.startsWith("/") && !f.includes("..")));
    // The repo files are exactly meta.files; PR body/meta/provenance stay bundle-local.
    assert.deepEqual(
      meta.files.slice().sort(),
      all.filter((f) => !["PR_BODY.md", "meta.json", "provenance.json"].includes(f)).sort(),
    );

    const body = fs.readFileSync(path.join(bundle.dir, "PR_BODY.md"), "utf8");
    assert.match(body, /^---\nrole: author\nmodel: claude-fable-5\ncostUsd: 0\.5123\n/, "provenance frontmatter");
    assert.match(body, /seed-pass \| PASS \(2\/2 branches\)/);
    assert.match(body, /Overlap score: \*\*0\.21\*\*/);
    assert.match(body, /Licensing \/ originality checklist/);
    assert.match(body, /## Cost report/);
    assert.match(body, /npm run dev/);
    assert.match(body, /## Ops tasks/);
    assert.ok(!body.includes("Warning:"), "no token warning by default");

    // Nothing in the bundle trips redaction.
    for (const rel of all) {
      const leaks = findRedactionLeaks(fs.readFileSync(path.join(bundle.dir, rel), "utf8"));
      assert.deepEqual(leaks, [], `${rel} leaks: ${JSON.stringify(leaks)}`);
    }

    // The recompiled manifest includes the draft (9 lessons).
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundle.dir, "apps/guided-repl/public/fixtures/v1/lessons.json"), "utf8"),
    );
    assert.equal(manifest.lessons.length, 9);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("draft bundle: token warning surfaces in the PR body when set", async () => {
  const validation = await makeValidation();
  const outDir = tmpOut();
  try {
    const bundle = buildDraftBundle({
      doc: parseYaml(YAML_TEXT),
      yamlText: YAML_TEXT,
      provenance: PROVENANCE,
      validation,
      card: CARD,
      settings,
      outDir,
      now: NOW,
      tokenWarning: "opened with GITHUB_TOKEN — CI will not auto-trigger; close/reopen to run checks",
    });
    const body = fs.readFileSync(path.join(bundle.dir, "PR_BODY.md"), "utf8");
    assert.match(body, /Warning:.*GITHUB_TOKEN/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("radar bundle: notes + cursors + radar.md decisions table", () => {
  const outDir = tmpOut();
  try {
    const bundle = buildRadarBundle({
      notes: [
        { sourceId: "hf-blog", path: "notes/2026-07/hf-blog.md", markdown: "# hf-blog\n\n- new eval tooling\n" },
      ],
      cards: [
        { topic: "Evaluating RAG retrieval quality", kind: "lesson", sourceId: "hf-blog", overlapScore: 0.21, decision: "drafted" },
        { topic: "Ship a landing page again", kind: "lesson", sourceId: "hf-blog", overlapScore: 0.91, decision: "gated-out", reason: "overlap 0.91 >= 0.65 with lesson l1" },
        { topic: "Yet another topic", kind: "lesson", sourceId: "hf-blog", overlapScore: 0.1, decision: "over-budget", reason: "projected $12.10 > cap $10" },
        { topic: "New model: Claude Sonnet 5", kind: "bench", sourceId: "anthropic-news", decision: "bench" },
      ],
      cursors: { sources: { "hf-blog": { seenHashes: ["abc"], lastRunAt: "2026-07-12T14:00:00.000Z" } } },
      errors: [{ sourceId: "dead-feed", message: "fetch failed: HTTP 404" }],
      settings,
      outDir,
      usage: { scout: { calls: 3, costUsd: 0.0123 }, author: { drafts: 1, costUsd: 2.1 }, totalUsd: 2.1123 },
      now: NOW,
    });

    assert.equal(bundle.branchName, "foundry/radar-2026-07");
    assert.deepEqual(bundle.labels, ["foundry:radar"]);
    assert.deepEqual(
      bundle.files.slice().sort(),
      ["foundry/notes/2026-07/hf-blog.md", "foundry/notes/2026-07/radar.md", "foundry/state/cursors.json"],
    );

    const radar = fs.readFileSync(path.join(bundle.dir, "foundry/notes/2026-07/radar.md"), "utf8");
    assert.match(radar, /drafted/);
    assert.match(radar, /gated-out — overlap 0\.91 >= 0\.65 with lesson l1/);
    assert.match(radar, /over-budget — projected \$12\.10 > cap \$10/);
    assert.match(radar, /dead-feed.*HTTP 404/);
    assert.match(radar, /scout: 3 call\(s\), \$0\.0123/);
    assert.match(radar, /author: 1 draft\(s\), \$2\.1000/);
    assert.match(radar, /total: \$2\.1123/);

    const body = fs.readFileSync(path.join(bundle.dir, "PR_BODY.md"), "utf8");
    assert.match(body, /1 bench trigger\(s\) fired/);
    assert.match(body, /## Ops tasks/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("radar bundle: leaking note fails hard", () => {
  const outDir = tmpOut();
  try {
    assert.throws(
      () =>
        buildRadarBundle({
          notes: [{ sourceId: "x", path: "notes/2026-07/x.md", markdown: "note with sk-ant-secret inside" }],
          cards: [],
          cursors: { sources: {} },
          errors: [],
          settings,
          outDir,
          now: NOW,
        }),
      /redaction: radar bundle note x/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("queue: gh pr list through injected exec + formatting", async () => {
  const calls = [];
  const execImpl = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return {
      stdout: JSON.stringify([
        { number: 41, title: "Foundry draft: Evaluating RAG retrieval quality (l9)", url: "https://github.com/x/y/pull/41", createdAt: "2026-07-12T14:05:00Z", headRefName: "foundry/draft-l9-20260712", isDraft: true },
      ]),
    };
  };
  const prs = await listQueue({ label: settings.labels.draft, execImpl });
  assert.equal(prs.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["gh", "pr", "list", "--label"]);
  assert.ok(calls[0].includes("foundry:draft"));

  const text = formatQueue(prs, settings.labels.draft);
  assert.match(text, /#41 {2}\[draft\] Foundry draft/);
  assert.match(formatQueue([], settings.labels.draft), /Review queue empty/);
});
