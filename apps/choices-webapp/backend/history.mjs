// Pure pair-history logic (no I/O, mirrors stats.mjs's testability rule).
//
// Suggestion engine Phase 0 (see ObsidianVault: Choices Suggestion Engine
// Plan): every finished game folds its 4 entries + winner into a compact
// per-pairing HIST# item — the L1 "pair memory" suggestion source. Entries
// are keyed by normalized label, capped, LRU-evicted by lastAt. The item
// shares the pairing's lifecycle (its ttl refreshes only on completion),
// so pair memory never outlives the pairing.

import { utcDay } from "./stats.mjs";

export const HIST_CAP = 200;

// Canonical suggestion key: lowercased, trimmed, control/zero-width chars
// stripped, inner whitespace collapsed. Also the text form stored in the
// anonymized global feed.
export function normalizeLabel(label) {
  return String(label ?? "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Fold one completed game into a HIST# item. summary: gameSummary() output.
// Returns a NEW hist object (entries map replaced, updatedAt bumped).
export function applyGameToHistory(hist, summary, now = Date.now()) {
  const entries = { ...(hist.entries ?? {}) };
  const winnerKey = normalizeLabel(summary.winnerLabel);
  for (const label of summary.choices) {
    const key = normalizeLabel(label);
    if (!key) continue;
    const prev = entries[key] ?? {
      label: String(label).trim(),
      entryCount: 0,
      winCount: 0,
      lastAt: 0,
    };
    entries[key] = {
      ...prev,
      entryCount: prev.entryCount + 1,
      winCount: prev.winCount + (key === winnerKey ? 1 : 0),
      lastAt: now,
    };
  }
  return { ...hist, entries: evictPastCap(entries), updatedAt: now };
}

// Keep the HIST_CAP most recently seen entries so the item can't grow
// unboundedly (same containment idea as stats.mjs's bumpWinner).
function evictPastCap(entries) {
  const keys = Object.keys(entries);
  if (keys.length <= HIST_CAP) return entries;
  const keep = keys
    .sort((a, b) => entries[b].lastAt - entries[a].lastAt)
    .slice(0, HIST_CAP);
  return Object.fromEntries(keep.map((k) => [k, entries[k]]));
}

// The anonymized global-feed record for one finished game (Phase 0's S3
// append; Phase 2's nightly batch reads these). Deliberately tiny: day (no
// exact timestamp), normalized texts, and a keyed pairHash — never a
// pairingId — so the k-anonymity floor can count distinct pairs without the
// store being linkable back to anyone.
export function anonRecord(summary, pairHash) {
  return {
    day: utcDay(summary.completedAt),
    choices: summary.choices.map(normalizeLabel),
    winner: normalizeLabel(summary.winnerLabel),
    pairHash,
  };
}
