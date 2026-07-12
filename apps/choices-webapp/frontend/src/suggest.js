// Pure suggestion merge/rank (no I/O) — suggestion engine ranking v1:
// score = 3·winCount + 2·entryCount·recencyDecay (30-day half-life), prefix
// matches before substring matches, pair memory always above Places results,
// dedupe by normalized text. Kept dependency-free so it can gain unit tests
// when the frontend grows a runner.

const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
const MAX_SHOWN = 6;

export function normalizeText(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function recencyDecay(lastAt, now) {
  if (!lastAt || lastAt > now) return 1;
  return 0.5 ** ((now - lastAt) / HALF_LIFE_MS);
}

// pairEntries: [{ label, entryCount, winCount, lastAt }] (HIST# values).
// placesResults: [{ text, placeId }]. Returns [{ key, label, source,
// placeId? }] capped at MAX_SHOWN.
export function rankSuggestions(query, pairEntries, placesResults, now = Date.now()) {
  const q = normalizeText(query);
  const out = [];
  const seen = new Set();

  const scored = (pairEntries ?? [])
    .map((e) => ({ e, key: normalizeText(e.label) }))
    .filter(({ key }) => key && key !== q && (!q || key.includes(q)))
    .map(({ e, key }) => ({
      key,
      label: e.label,
      source: "pair",
      prefix: !q || key.startsWith(q) ? 1 : 0,
      score:
        3 * (e.winCount || 0) +
        2 * (e.entryCount || 0) * recencyDecay(e.lastAt, now),
    }))
    .sort((a, b) => b.prefix - a.prefix || b.score - a.score);
  for (const s of scored) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push({ key: s.key, label: s.label, source: "pair" });
  }

  for (const p of placesResults ?? []) {
    const key = normalizeText(p.text);
    if (!key || key === q || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: p.text, placeId: p.placeId, source: "places" });
  }

  return out.slice(0, MAX_SHOWN);
}

// suggestion_shown volume bound: report each layer at most once per app
// session (event catalog bundle B: {layer, count} — never the query text).
// Returns the [{layer, count}] entries that still need reporting.
const reportedLayers = new Set();
export function suggestionLayersToReport(suggestions) {
  const counts = {};
  for (const s of suggestions ?? []) {
    counts[s.source] = (counts[s.source] || 0) + 1;
  }
  const out = [];
  for (const [layer, count] of Object.entries(counts)) {
    if (reportedLayers.has(layer)) continue;
    reportedLayers.add(layer);
    out.push({ layer, count });
  }
  return out;
}
