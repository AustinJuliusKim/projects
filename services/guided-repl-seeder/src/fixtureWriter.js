/**
 * Assembles and writes FixtureEnvelope / SnapshotManifest JSON files.
 */

import fs from "node:fs";
import path from "node:path";
import { validateFixture } from "@guided-repl/protocol";

/**
 * @typedef {object} FixtureInput
 * @property {string} lessonId
 * @property {string} branchId
 * @property {string} claudeCodeVersion
 * @property {string} seedSnapshotId
 * @property {string} permissionMode
 * @property {string} expectedPrompt
 * @property {import("@guided-repl/protocol").FixtureKind} [kind] defaults to "claudeStream"
 * @property {import("@guided-repl/protocol").FixtureEvent[]} events
 * @property {import("@guided-repl/protocol").Assertion} assertion
 */

/**
 * Builds and validates a FixtureEnvelope. `kind` is stamped explicitly on
 * new recordings ("claudeStream" unless overridden, e.g. future drill
 * transcript recordings); pre-kind committed fixtures stay valid via the
 * absent-means-claudeStream default.
 *
 * @param {FixtureInput} input
 * @returns {import("@guided-repl/protocol").FixtureEnvelope}
 */
export function buildFixture(input) {
  const fixture = {
    fixtureVersion: 1,
    kind: input.kind ?? "claudeStream",
    claudeCodeVersion: input.claudeCodeVersion,
    lessonId: input.lessonId,
    branchId: input.branchId,
    recordedAt: new Date().toISOString(),
    seedSnapshotId: input.seedSnapshotId,
    permissionMode: input.permissionMode,
    expectedPrompt: input.expectedPrompt,
    events: input.events,
    assertion: input.assertion,
  };
  validateFixture(fixture);
  return fixture;
}

/**
 * Writes a JSON-serializable object to `outPath`, creating parent
 * directories as needed.
 *
 * @param {object} obj
 * @param {string} outPath
 */
export function writeJson(obj, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + "\n");
}
