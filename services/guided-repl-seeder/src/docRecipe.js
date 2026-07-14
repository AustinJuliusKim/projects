/**
 * Doc-driven recipes: synthesize recording instructions directly from a
 * validated lesson document, for lessons that have no hand-written recipe
 * (Foundry drafts). v1 supports `simple` (acceptEdits) and `plan` branch
 * kinds only, seeded from a self-contained snapshot — multiplan/merge
 * lessons remain human-authored.
 */

import fs from "node:fs";

import { applyAuthorGate } from "./authorGate.js";
import { buildFixture } from "./fixtureWriter.js";
import { snapshotWorkspace } from "./snapshotter.js";
import { makeWorkspaceFromSnapshot, SEED_README } from "./workspace.js";
import { runSegment, getClaudeCodeVersion } from "./seedLib.js";

/** Fixture-embeddable assertion shapes (protocol assertions.js). */
const WORKSPACE_ASSERTION_TYPES = new Set([
  "file-contains",
  "file-exists",
  "terminal-matches",
  "file-equals",
]);

/**
 * Synthesizes a recipe from a validated lesson doc: each run-step branch
 * becomes one `claude -p` segment (plan branches get the authorGate
 * treatment at seed time).
 *
 * @param {object} doc validated lesson document
 * @returns {{lessonId: string, seedSnapshotId: string, assertion: object, branches: Record<string, {kind: "simple"|"plan", expectedPrompt: string, permissionMode: string, model?: string}>}}
 */
export function synthesizeRecipe(doc) {
  const runSteps = doc.steps.filter((s) => s.type === "run");
  if (runSteps.length !== 1) {
    throw new Error(`docRecipe: expected exactly one run step, found ${runSteps.length}`);
  }
  const assertionStep = doc.steps.find((s) => s.type === "assertion");
  if (!assertionStep) {
    throw new Error("docRecipe: lesson has no assertion step");
  }
  if (!WORKSPACE_ASSERTION_TYPES.has(assertionStep.rule.type)) {
    throw new Error(
      `docRecipe: assertion rule "${assertionStep.rule.type}" cannot be embedded in a fixture — v1 drafts need one of: ${[...WORKSPACE_ASSERTION_TYPES].join(", ")}`,
    );
  }

  const branches = {};
  for (const [branchId, branch] of Object.entries(runSteps[0].branches)) {
    if (branch.permissionMode === "plan") {
      branches[branchId] = { kind: "plan", expectedPrompt: branch.expectedPrompt, permissionMode: "plan" };
    } else if (branch.permissionMode === "acceptEdits") {
      branches[branchId] = {
        kind: "simple",
        expectedPrompt: branch.expectedPrompt,
        permissionMode: "acceptEdits",
        ...(branch.model ? { model: branch.model } : {}),
      };
    } else {
      throw new Error(
        `docRecipe: branch "${branchId}" permissionMode "${branch.permissionMode}" unsupported — v1 synthesizes acceptEdits/plan only`,
      );
    }
    if (branch.seedSnapshotId && branch.seedSnapshotId !== doc.snapshot.snapshotId) {
      throw new Error(
        `docRecipe: branch "${branchId}" seeds from "${branch.seedSnapshotId}" — doc-driven lessons are self-contained (${doc.snapshot.snapshotId})`,
      );
    }
  }

  return {
    lessonId: doc.id,
    seedSnapshotId: doc.snapshot.snapshotId,
    assertion: assertionStep.rule,
    branches,
  };
}

/**
 * The default self-contained seed for a Foundry draft: the same starter
 * workspace l1 records from.
 *
 * @param {string} snapshotId
 * @returns {import("@guided-repl/protocol").SnapshotManifest}
 */
export function starterSeedSnapshot(snapshotId) {
  return { snapshotId, files: [{ path: "README.md", content: SEED_README }] };
}

/**
 * Seeds every branch of a doc-driven lesson through the standard recording
 * path (map → normalize → pace → gate → buildFixture), with an injected
 * Runner. Returns in-memory fixtures plus a post-run workspace snapshot per
 * branch so callers can verify the lesson's assertion against real state.
 *
 * @param {object} opts
 * @param {object} opts.doc validated lesson document
 * @param {import("@guided-repl/protocol").SnapshotManifest} [opts.seedSnapshot] defaults to the starter workspace
 * @param {import("./runner/runner.js").Runner} opts.runner
 * @param {() => string} [opts.versionProvider] defaults to local `claude --version`
 * @returns {Promise<{seedSnapshot: object, fixtures: {branchId: string, fixture: object, postSnapshot: object}[]}>}
 */
export async function seedFromDoc({ doc, seedSnapshot, runner, versionProvider = getClaudeCodeVersion }) {
  const recipe = synthesizeRecipe(doc);
  const seed = seedSnapshot ?? starterSeedSnapshot(recipe.seedSnapshotId);
  if (seed.snapshotId !== recipe.seedSnapshotId) {
    throw new Error(`docRecipe: seed snapshot "${seed.snapshotId}" does not match lesson snapshot "${recipe.seedSnapshotId}"`);
  }
  const claudeCodeVersion = versionProvider();

  const fixtures = [];
  for (const [branchId, branch] of Object.entries(recipe.branches)) {
    const workspace = makeWorkspaceFromSnapshot(seed.files ? seed : { ...seed, files: [] });
    try {
      let events;
      if (branch.kind === "plan") {
        const planEvents = await runSegment(
          { prompt: branch.expectedPrompt, cwd: workspace, permissionMode: "plan" },
          { runner },
        );
        const execEvents = await runSegment(
          { prompt: branch.expectedPrompt, cwd: workspace, permissionMode: "acceptEdits" },
          { runner },
        );
        events = applyAuthorGate(planEvents, execEvents);
      } else {
        events = await runSegment(
          { prompt: branch.expectedPrompt, cwd: workspace, permissionMode: "acceptEdits", model: branch.model },
          { runner },
        );
      }

      const fixture = buildFixture({
        lessonId: recipe.lessonId,
        branchId,
        claudeCodeVersion,
        seedSnapshotId: recipe.seedSnapshotId,
        permissionMode: branch.permissionMode,
        expectedPrompt: branch.expectedPrompt,
        events,
        assertion: recipe.assertion,
      });
      const postSnapshot = snapshotWorkspace(workspace, `${recipe.lessonId}-${branchId}-post`);
      fixtures.push({ branchId, fixture, postSnapshot });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  return { seedSnapshot: seed, fixtures };
}
