import test from "node:test";
import assert from "node:assert/strict";

import { recipes, CHAIN_ORDER } from "../src/recipes/index.js";

test("CHAIN_ORDER lists l2..l8 once each, in order", () => {
  assert.deepEqual(CHAIN_ORDER, ["l2", "l3", "l4", "l5", "l6", "l7", "l8"]);
});

test("every recipe's lessonId matches its registry key", () => {
  for (const [key, recipe] of Object.entries(recipes)) {
    assert.equal(recipe.lessonId, key);
  }
});

test("l2 is a merge recipe with a source and annotations", () => {
  assert.equal(recipes.l2.kind, "merge");
  assert.equal(recipes.l2.source.lessonId, "l1");
  assert.equal(recipes.l2.source.branchId, "constrained");
  assert.ok(Array.isArray(recipes.l2.annotations) && recipes.l2.annotations.length >= 3);
  for (const a of recipes.l2.annotations) {
    assert.equal(typeof a.index, "number");
    assert.equal(typeof a.annotation.title, "string");
    assert.equal(typeof a.annotation.body, "string");
  }
});

test("every live-recording recipe (l3-l8) declares seedFrom and outputBranch", () => {
  for (const lessonId of ["l3", "l4", "l5", "l6", "l7", "l8"]) {
    const recipe = recipes[lessonId];
    assert.equal(typeof recipe.seedFrom, "string", `${lessonId}.seedFrom`);
    assert.equal(typeof recipe.outputBranch, "string", `${lessonId}.outputBranch`);
    assert.ok(recipe.branches[recipe.outputBranch], `${lessonId}.outputBranch must be one of its own branches`);
  }
});

test("snapshot chain: each recipe's seedFrom matches the prior lesson's <lessonId>-output", () => {
  const chain = ["l1", "l3", "l4", "l5", "l6", "l7", "l8"];
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const cur = chain[i];
    if (cur === "l1") continue;
    assert.equal(recipes[cur].seedFrom, `${prev}-output`, `${cur}.seedFrom`);
  }
});

test("l4's revise branch is a 3-segment multiplan with matching gate counts", () => {
  const revise = recipes.l4.branches.revise;
  assert.equal(revise.kind, "multiplan");
  assert.equal(revise.segments.length, 3);
  assert.equal(revise.gates.length, revise.segments.length - 1);
});

test("l7's branches declare distinct snapshotIds and the with branch layers a CLAUDE.md", () => {
  const { without, with: withBranch } = recipes.l7.branches;
  assert.equal(without.snapshotId, "l7-input-plain");
  assert.equal(withBranch.snapshotId, "l7-input-claudemd");
  assert.notEqual(without.snapshotId, withBranch.snapshotId);
  assert.ok(withBranch.extraFiles.some((f) => f.path === "CLAUDE.md"));
});

test("l8's branches declare a model kind with explicit, distinct model pins", () => {
  const { haiku, sonnet } = recipes.l8.branches;
  assert.equal(haiku.kind, "model");
  assert.equal(sonnet.kind, "model");
  assert.equal(typeof haiku.model, "string");
  // Pinned (not session default) so the recorded usage.model contrast is a
  // real Haiku-vs-Sonnet comparison regardless of the recording session.
  assert.equal(sonnet.model, "claude-sonnet-5");
  assert.notEqual(haiku.model, sonnet.model);
});
