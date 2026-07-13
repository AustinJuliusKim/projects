/**
 * Scout cursor state: content-hash dedupe per source, persisted at
 * foundry/state/cursors.json. Because everything the Foundry emits is
 * PR-only, the state file on main can lag unmerged radar PRs — hashing item
 * content makes re-runs idempotent (already-summarized items are skipped)
 * at the cost of some re-summarization if hashes were pruned.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Cap per-source hash memory; oldest are pruned first. */
export const MAX_SEEN_HASHES = 500;

/**
 * @param {import("../sources/fetchers.js").SourceItem} item
 * @returns {string} stable content hash of the item's identity + visible content
 */
export function itemHash(item) {
  return createHash("sha256")
    .update(JSON.stringify([item.id, item.title, item.date ?? ""]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * @param {string} path
 * @returns {{sources: Record<string, {seenHashes: string[], lastRunAt?: string}>}}
 */
export function readCursors(path) {
  if (!existsSync(path)) return { sources: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { sources: parsed.sources ?? {} };
}

/**
 * @param {string} path
 * @param {{sources: Record<string, object>}} cursors
 */
export function writeCursors(path, cursors) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cursors, null, 2)}\n`);
}

/**
 * Splits fetched items into new-vs-seen for one source and returns the
 * updated per-source cursor state. Pure — callers persist via writeCursors.
 *
 * @param {{seenHashes?: string[]}} sourceState
 * @param {import("../sources/fetchers.js").SourceItem[]} items
 * @param {{now?: () => Date}} [opts]
 * @returns {{newItems: import("../sources/fetchers.js").SourceItem[], state: {seenHashes: string[], lastRunAt: string}}}
 */
export function filterNewItems(sourceState, items, { now = () => new Date() } = {}) {
  const seen = new Set(sourceState.seenHashes ?? []);
  const newItems = items.filter((item) => !seen.has(itemHash(item)));
  const merged = [...(sourceState.seenHashes ?? []), ...newItems.map(itemHash)];
  return {
    newItems,
    state: {
      seenHashes: merged.slice(-MAX_SEEN_HASHES),
      lastRunAt: now().toISOString(),
    },
  };
}
