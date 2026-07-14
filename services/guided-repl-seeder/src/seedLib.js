/**
 * Reusable seeding internals, extracted from cli.js so other tooling (the
 * Lesson Foundry's validate+seed stage) can drive recordings with an
 * injected Runner and version provider. The CLI keeps its exact behavior by
 * importing these with the defaults (LocalRunner + local `claude --version`).
 */

import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { run as localRun } from "./runner/localRunner.js";
import { mapEvent } from "./streamMapper.js";
import { normalizeFrame } from "./normalizer.js";
import { computePacing } from "./pacing.js";
import { applyAuthorGate } from "./authorGate.js";
import { captureModelFromRaw, stampUsageModel } from "./modelStamp.js";
import { buildFixture } from "./fixtureWriter.js";
import { makeSeedWorkspace } from "./workspace.js";

/** @type {import("./runner/runner.js").Runner} */
export const defaultRunner = { run: localRun };

/**
 * Runs `claude --version` locally and returns its trimmed output. In CI the
 * version must come from inside the sandbox instead — pass a
 * `versionProvider` wherever this is accepted.
 *
 * @returns {string}
 */
export function getClaudeCodeVersion() {
  return execFileSync("claude", ["--version"]).toString().trim();
}

/**
 * Consumes a Runner's raw NDJSON stream, mapping/normalizing each event
 * into paced fixture events (no awaitClient markers — those are added by
 * authorGate for the plan branch).
 *
 * @param {AsyncIterable<object>} rawEvents
 * @param {string} cwd
 * @returns {Promise<import("@guided-repl/protocol").FixtureEvent[]>}
 */
export async function collectPacedEvents(rawEvents, cwd) {
  // Resolve symlinks (e.g. macOS /tmp -> /private/tmp, /var -> /private/var)
  // so the normalizer's cwd match lines up with the *resolved* absolute
  // paths the claude CLI reports in tool_use/tool_result payloads.
  const realCwd = fs.realpathSync(cwd);
  const timed = [];
  let model;
  for await (const raw of rawEvents) {
    const capturedModel = captureModelFromRaw(raw);
    if (capturedModel) model = capturedModel;
    const tMs = Date.now();
    for (const frame of mapEvent(raw)) {
      timed.push({ frame: normalizeFrame(frame, { cwd: realCwd }), tMs });
    }
  }
  return stampUsageModel(computePacing(timed), model);
}

/**
 * Runs one `claude -p` segment in `cwd` and returns its paced, normalized,
 * model-stamped fixture events.
 *
 * @param {{prompt: string, cwd: string, permissionMode: string, model?: string|null}} opts
 * @param {{runner?: import("./runner/runner.js").Runner}} [deps]
 * @returns {Promise<import("@guided-repl/protocol").FixtureEvent[]>}
 */
export async function runSegment(opts, { runner = defaultRunner } = {}) {
  const rawEvents = runner.run({
    prompt: opts.prompt,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    ...(opts.model ? { model: opts.model } : {}),
  });
  return collectPacedEvents(rawEvents, opts.cwd);
}

/**
 * Records one non-plan branch (single acceptEdits run) in a fresh starter
 * workspace.
 *
 * @param {{lessonId: string, branchId: string, expectedPrompt: string, permissionMode: string, assertion: object, claudeCodeVersion: string, seedSnapshotId: string}} opts
 * @param {{runner?: import("./runner/runner.js").Runner}} [deps]
 * @returns {Promise<{fixture: object, workspace: string}>}
 */
export async function recordSimpleBranch(opts, { runner = defaultRunner } = {}) {
  const workspace = makeSeedWorkspace();
  const events = await runSegment(
    { prompt: opts.expectedPrompt, cwd: workspace, permissionMode: opts.permissionMode },
    { runner },
  );
  const fixture = buildFixture({
    lessonId: opts.lessonId,
    branchId: opts.branchId,
    claudeCodeVersion: opts.claudeCodeVersion,
    seedSnapshotId: opts.seedSnapshotId,
    permissionMode: opts.permissionMode,
    expectedPrompt: opts.expectedPrompt,
    events,
    assertion: opts.assertion,
  });
  return { fixture, workspace };
}

/**
 * Records the plan-mode branch: a plan run, then an acceptEdits execution
 * run in the same workspace with the same prompt, spliced via authorGate.
 *
 * @param {{lessonId: string, branchId: string, expectedPrompt: string, assertion: object, claudeCodeVersion: string, seedSnapshotId: string}} opts
 * @param {{runner?: import("./runner/runner.js").Runner}} [deps]
 * @returns {Promise<{fixture: object, workspace: string}>}
 */
export async function recordPlanBranch(opts, { runner = defaultRunner } = {}) {
  const workspace = makeSeedWorkspace();

  const planEvents = await runSegment(
    { prompt: opts.expectedPrompt, cwd: workspace, permissionMode: "plan" },
    { runner },
  );
  const executionEvents = await runSegment(
    { prompt: opts.expectedPrompt, cwd: workspace, permissionMode: "acceptEdits" },
    { runner },
  );
  const events = applyAuthorGate(planEvents, executionEvents);

  const fixture = buildFixture({
    lessonId: opts.lessonId,
    branchId: opts.branchId,
    claudeCodeVersion: opts.claudeCodeVersion,
    seedSnapshotId: opts.seedSnapshotId,
    permissionMode: "plan",
    expectedPrompt: opts.expectedPrompt,
    events,
    assertion: opts.assertion,
  });
  return { fixture, workspace };
}

export { makeSeedWorkspace, makeWorkspaceFromSnapshot, SEED_README } from "./workspace.js";
export { snapshotWorkspace } from "./snapshotter.js";
export { buildFixture, writeJson } from "./fixtureWriter.js";
