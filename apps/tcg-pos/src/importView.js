// Pure helpers for the TCGplayer Import page (tested with node --test).

export const MAX_IMPORT_BYTES = 2_000_000; // mirrors the API's cap

export function checkFile(file) {
  if (!file) return "Choose a CSV file.";
  if (file.size > MAX_IMPORT_BYTES) return "File is larger than 2 MB; split it.";
  return null;
}

// "5 matched · 3 unmatched · 1 skipped — 4 items, +9 qty"
export function summarize(result) {
  if (!result || !result.totals) return "";
  const t = result.totals;
  const sign = t.qty_delta > 0 ? "+" : "";
  return (
    `${t.matched} matched · ${t.unmatched} unmatched · ${t.skipped} skipped — ` +
    `${t.changed} of ${t.grains} item${t.grains === 1 ? "" : "s"} change, ${sign}${t.qty_delta} qty`
  );
}

const STATUS_ORDER = { unmatched: 0, matched: 1, skipped: 2 };

// Problems first, so the clerk sees what needs fixing at the top.
export function sortRows(rows) {
  return [...(rows || [])].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.row - b.row,
  );
}

export const statusColor = (status) =>
  ({ matched: "green", unmatched: "red", skipped: "gray" })[status] || "gray";

// Apply is only offered for a dry run of the same file that found something
// to change.
export function canApply(preview, fileKey) {
  return Boolean(
    preview && preview.dryRun && preview.fileKey === fileKey && preview.result.totals.changed > 0,
  );
}
