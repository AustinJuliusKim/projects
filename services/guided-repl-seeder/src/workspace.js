/**
 * Tmp workspace construction for recording runs: a bare starter workspace
 * (l1) or one materialized from a prior lesson's output SnapshotManifest,
 * optionally layered with extra branch-specific files (e.g. L7's CLAUDE.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SEED_README = "# My Page\n\nStarter workspace.\n";

/**
 * Creates a fresh tmp workspace seeded with the starter README (l1 only).
 * @returns {string} workspace dir
 */
export function makeSeedWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guided-repl-seed-"));
  fs.writeFileSync(path.join(dir, "README.md"), SEED_README);
  return dir;
}

/**
 * Materializes a SnapshotManifest's files into a fresh tmp workspace, then
 * layers `extraFiles` on top (added or overwritten).
 *
 * @param {import("@guided-repl/protocol").SnapshotManifest} snapshot
 * @param {{path: string, content: string}[]} [extraFiles]
 * @returns {string} workspace dir
 */
export function makeWorkspaceFromSnapshot(snapshot, extraFiles = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guided-repl-seed-"));
  for (const file of snapshot.files) {
    const full = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  for (const file of extraFiles) {
    const full = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  return dir;
}
