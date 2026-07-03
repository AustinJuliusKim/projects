/**
 * Recursively snapshots a workspace directory into a SnapshotManifest.
 */

import fs from "node:fs";
import path from "node:path";
import { validateSnapshot } from "@guided-repl/protocol";
import { sanitizeString } from "./normalizer.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * @param {string} dir
 * @param {string} base
 * @param {string} cwd
 * @param {{path: string, content: string}[]} files
 */
function walk(dir, base, cwd, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, cwd, files);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      const content = sanitizeString(fs.readFileSync(full, "utf8"), { cwd });
      files.push({ path: rel, content });
    }
  }
}

/**
 * Reads `dir` recursively (skipping node_modules/.git) into a
 * SnapshotManifest, sanitizing each file's content the same way frame
 * payloads are (paths/uuids/emails/etc.), and validated before returning.
 *
 * @param {string} dir
 * @param {string} snapshotId
 * @returns {import("@guided-repl/protocol").SnapshotManifest}
 */
export function snapshotWorkspace(dir, snapshotId) {
  const realDir = fs.realpathSync(dir);
  const files = [];
  walk(dir, dir, realDir, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { snapshotId, files };
  validateSnapshot(manifest);
  return manifest;
}
