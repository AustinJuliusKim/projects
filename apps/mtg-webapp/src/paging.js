// Client-side pagination helpers for SimilarPanel: the API is fetched once
// at its max (`limit: 50`) and paged in the browser, so this stays pure and
// framework-free (no re-fetch on page change). Impression-logging integrity
// depends on `unloggedItems` — see SimilarPanel.jsx.

// 1-indexed `page`, matching Mantine's <Pagination>. Out-of-range pages
// (before 1, past the last page) clamp to an empty slice rather than
// throwing — callers don't have to pre-validate.
export function pageSlice(items, page, pageSize) {
  if (!items || !items.length || pageSize <= 0) return [];
  const start = (page - 1) * pageSize;
  if (start < 0 || start >= items.length) return [];
  return items.slice(start, start + pageSize);
}

// Items not yet present in `loggedIds` (a Set of oracle_ids already
// logged this mount) — so a panel that re-renders the same page, or a user
// paging back to a page they've already seen, never logs a duplicate
// impression for the same result.
export function unloggedItems(items, loggedIds) {
  return items.filter((item) => !loggedIds.has(item.oracle_id));
}
