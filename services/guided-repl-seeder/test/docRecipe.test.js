import test from "node:test";
import assert from "node:assert/strict";

import { validateFixture, validateSnapshot } from "@guided-repl/protocol";
import { synthesizeRecipe, starterSeedSnapshot, seedFromDoc } from "../src/docRecipe.js";
import { createFakeRunner, makeDraftScript } from "./fakes/fakeRunner.js";

/** Minimal validated-shape draft doc (Foundry v1 constraints). */
function draftDoc() {
  return {
    schemaVersion: 1,
    id: "l9",
    slug: "evaluating-rag-retrieval-quality",
    title: "Evaluating RAG retrieval quality",
    track: "advanced",
    order: 9,
    durationTargetSec: 300,
    prereqs: [],
    snapshot: { snapshotId: "l9-input" },
    fixtures: {
      measure: { path: "fixtures/l9/measure.json", kind: "claudeStream" },
      "plan-first": { path: "fixtures/l9/plan-first.json", kind: "claudeStream" },
    },
    steps: [
      { type: "instruction", id: "intro", md: "intro" },
      {
        type: "run",
        id: "run",
        branches: {
          measure: { fixture: "measure", expectedPrompt: "write eval.md scoring recall", permissionMode: "acceptEdits" },
          "plan-first": { fixture: "plan-first", expectedPrompt: "write eval.md scoring recall", permissionMode: "plan" },
        },
      },
      { type: "assertion", id: "grade", rule: { type: "file-contains", path: "eval.md", match: "recall" } },
    ],
    completion: { assertionIds: ["grade"], next: null },
  };
}

test("synthesizeRecipe maps run branches to simple/plan segments", () => {
  const recipe = synthesizeRecipe(draftDoc());
  assert.equal(recipe.lessonId, "l9");
  assert.equal(recipe.seedSnapshotId, "l9-input");
  assert.equal(recipe.branches.measure.kind, "simple");
  assert.equal(recipe.branches["plan-first"].kind, "plan");
  assert.deepEqual(recipe.assertion, { type: "file-contains", path: "eval.md", match: "recall" });
});

test("synthesizeRecipe rejects unsupported shapes with precise errors", () => {
  const noRun = draftDoc();
  noRun.steps = noRun.steps.filter((s) => s.type !== "run");
  assert.throws(() => synthesizeRecipe(noRun), /exactly one run step, found 0/);

  const badMode = draftDoc();
  badMode.steps[1].branches.measure.permissionMode = "bypassPermissions";
  assert.throws(() => synthesizeRecipe(badMode), /unsupported — v1 synthesizes acceptEdits\/plan only/);

  const badAssertion = draftDoc();
  badAssertion.steps[2].rule = { type: "quizCorrect", stepId: "quiz" };
  assert.throws(() => synthesizeRecipe(badAssertion), /cannot be embedded in a fixture/);

  const chained = draftDoc();
  chained.steps[1].branches.measure.seedSnapshotId = "l8-output";
  assert.throws(() => synthesizeRecipe(chained), /self-contained/);
});

test("starterSeedSnapshot is a valid self-contained seed", () => {
  const snap = starterSeedSnapshot("l9-input");
  validateSnapshot(snap);
  assert.equal(snap.files[0].path, "README.md");
});

test("seedFromDoc records every branch through the standard path with an injected runner", async () => {
  const runner = createFakeRunner(makeDraftScript());
  const { fixtures, seedSnapshot } = await seedFromDoc({
    doc: draftDoc(),
    runner,
    versionProvider: () => "9.9.9 (Claude Code)",
  });

  assert.equal(seedSnapshot.snapshotId, "l9-input");
  assert.equal(fixtures.length, 2);
  // plan branch = plan + exec segments, simple = one segment → 3 runner calls.
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(
    runner.calls.map((c) => c.permissionMode),
    ["acceptEdits", "plan", "acceptEdits"],
  );

  for (const { branchId, fixture, postSnapshot } of fixtures) {
    validateFixture(fixture);
    assert.equal(fixture.lessonId, "l9");
    assert.equal(fixture.claudeCodeVersion, "9.9.9 (Claude Code)");
    assert.equal(fixture.seedSnapshotId, "l9-input");
    validateSnapshot(postSnapshot);
    const evalFile = postSnapshot.files.find((f) => f.path === "eval.md");
    assert.ok(evalFile && /recall/.test(evalFile.content), `${branchId} post-run workspace has eval.md`);
  }

  const plan = fixtures.find((f) => f.branchId === "plan-first").fixture;
  assert.equal(plan.permissionMode, "plan");
  const gate = plan.events.find((e) => "awaitClient" in e);
  assert.deepEqual(gate, { awaitClient: "permission", choices: ["approve", "deny"] });
  // Model id captured from the fake stream's system/init is stamped on usage.
  const usage = plan.events.find((e) => e.frame?.type === "usage");
  assert.equal(usage.frame.payload.model, "claude-sonnet-4-6");

  const simple = fixtures.find((f) => f.branchId === "measure").fixture;
  const toolUse = simple.events.find((e) => e.frame?.type === "tool_use");
  assert.equal(toolUse.frame.payload.input.file_path, "eval.md", "workspace paths normalized to relative");
});

test("seedFromDoc rejects a mismatched seed snapshot id", async () => {
  const runner = createFakeRunner(makeDraftScript());
  await assert.rejects(
    seedFromDoc({ doc: draftDoc(), seedSnapshot: { snapshotId: "other", files: [] }, runner, versionProvider: () => "v" }),
    /does not match lesson snapshot/,
  );
});
