import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { validateDraft, verifyAssertion } from "../src/validate/validateDraft.js";
import { createFakeRunner, makeDraftScript } from "guided-repl-seeder/test/fakes/fakeRunner.js";

const YAML_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/valid-draft.yaml", import.meta.url)), "utf8");
const DOC = () => parseYaml(YAML_TEXT);
const VERSION = () => "9.9.9 (Claude Code)";

test("happy path: schemaPass + seedPass with a staging compile including the draft", async () => {
  const runner = createFakeRunner(makeDraftScript());
  const { schemaPass, seedPass, report, artifacts } = await validateDraft({
    doc: DOC(),
    yamlText: YAML_TEXT,
    runner,
    versionProvider: VERSION,
  });

  assert.equal(schemaPass, true, JSON.stringify(report, null, 2));
  assert.equal(seedPass, true);
  assert.equal(report.schema.pass, true);
  assert.equal(report.lint.pass, true);
  assert.equal(report.compile.pass, true);
  assert.equal(report.redaction.pass, true);
  assert.equal(report.seed.branches.length, 2);
  for (const b of report.seed.branches) assert.equal(b.pass, true, b.detail);

  // The staging manifest contains the committed 8 lessons + the draft.
  assert.equal(artifacts.manifest.lessons.length, 9);
  assert.ok(artifacts.manifest.lessons.some((l) => l.id === "l9"));
  assert.equal(artifacts.fixtures.length, 2);
  assert.equal(artifacts.seedSnapshot.snapshotId, "l9-input");
});

test("seed failure: assertion not satisfied by the real run → seedPass false, schemaPass unaffected", async () => {
  // The run writes notes.md instead of eval.md — the draft's own assertion fails.
  const runner = createFakeRunner(makeDraftScript({ fileName: "notes.md" }));
  const { schemaPass, seedPass, report } = await validateDraft({
    doc: DOC(),
    yamlText: YAML_TEXT,
    runner,
    versionProvider: VERSION,
  });

  assert.equal(seedPass, false);
  assert.equal(schemaPass, true, "structure is still publishable; seed-pass is the separate gate");
  for (const b of report.seed.branches) {
    assert.equal(b.pass, false);
    assert.match(b.detail, /eval\.md missing/);
  }
});

test("lint failure stops before seeding", async () => {
  const doc = DOC();
  doc.durationTargetSec = 400;
  const runner = createFakeRunner(makeDraftScript());
  const { schemaPass, seedPass, report } = await validateDraft({
    doc,
    yamlText: YAML_TEXT,
    runner,
    versionProvider: VERSION,
  });
  assert.equal(schemaPass, false);
  assert.equal(seedPass, false);
  assert.equal(report.lint.failures[0].rule, "duration-cap");
  assert.equal(report.seed.branches.length, 0, "no model/runner spend on a structurally bad draft");
  assert.equal(runner.calls.length, 0);
});

test("redaction leak in the draft YAML fails schemaPass", async () => {
  const leakyYaml = `# reviewed at /Users/somebody/desk\n${YAML_TEXT}`;
  const runner = createFakeRunner(makeDraftScript());
  const { schemaPass, report } = await validateDraft({
    doc: DOC(),
    yamlText: leakyYaml,
    runner,
    versionProvider: VERSION,
  });
  assert.equal(schemaPass, false);
  assert.equal(report.redaction.pass, false);
  assert.equal(report.redaction.leaks[0].where, "draft yaml");
  assert.equal(report.redaction.leaks[0].name, "/Users/ path");
});

test("verifyAssertion covers the workspace-checkable rule types", () => {
  const snap = { files: [{ path: "eval.md", content: "recall: 0.82\n" }] };
  const textEvents = [{ frame: { type: "text", payload: { delta: "All 12 checks passed" } }, delayMs: 0 }];

  assert.equal(verifyAssertion({ type: "file-contains", path: "eval.md", match: "recall" }, snap, []).pass, true);
  assert.equal(verifyAssertion({ type: "file-contains", path: "eval.md", match: "precision" }, snap, []).pass, false);
  assert.equal(verifyAssertion({ type: "file-exists", path: "eval.md" }, snap, []).pass, true);
  assert.equal(verifyAssertion({ type: "file-exists", path: "nope.md" }, snap, []).pass, false);
  assert.equal(verifyAssertion({ type: "file-equals", path: "eval.md", content: "recall: 0.82\n" }, snap, []).pass, true);
  assert.equal(verifyAssertion({ type: "terminal-matches", match: "12 checks" }, snap, textEvents).pass, true);
  assert.equal(verifyAssertion({ type: "terminal-matches", match: "zero checks" }, snap, textEvents).pass, false);
  assert.equal(verifyAssertion({ type: "quizCorrect", stepId: "q" }, snap, []).pass, false);
});
