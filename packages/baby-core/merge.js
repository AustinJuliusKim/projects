/**
 * Event-log merge. This is the whole sync design: every device owns exactly
 * one S3 object and writes only that one, so there is never a concurrent
 * writer on a key and no lock is needed. Reconciliation happens here, on
 * read, by merging every device's log.
 *
 * @typedef {import("./schemas.js").TimelineEvent} TimelineEvent
 */

/**
 * Deterministic tiebreak for two versions of the same event id.
 *
 * Commutativity is a hard requirement, not a nicety: either device may sync
 * first, and both must land on identical state. So this must be a *total*
 * order — comparing only `revision` leaves genuine ties (same id, same
 * revision, different content) resolved by argument order, which silently
 * makes merge(a,b) ≠ merge(b,a).
 *
 * @param {TimelineEvent} x
 * @param {TimelineEvent} y
 * @returns {TimelineEvent} the winner
 */
function pickWinner(x, y) {
  if (x.revision !== y.revision) return x.revision > y.revision ? x : y;
  if (x.createdAt !== y.createdAt) return x.createdAt > y.createdAt ? x : y;
  // Last resort: compare a stable serialization so the result is independent
  // of which log the event arrived in.
  return stableStringify(x) >= stableStringify(y) ? x : y;
}

/**
 * JSON with object keys sorted at every depth, so two structurally equal
 * events always serialize identically regardless of key insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Merges any number of event logs into one.
 *
 * Dedupes by `id` (highest revision wins), then sorts by `ts` ascending with
 * `id` as a stable tiebreak. Tombstones are carried through untouched —
 * a deleted event stays in the log forever, because with multi-writer merge
 * a delete expressed as *absence* is indistinguishable from "this device
 * hasn't seen it yet", and the next merge would resurrect it. Projections
 * filter `deleted` at read time instead.
 *
 * Pure: never mutates its inputs.
 *
 * @param {...TimelineEvent[]} logs
 * @returns {TimelineEvent[]}
 */
export function mergeEvents(...logs) {
  /** @type {Map<string, TimelineEvent>} */
  const byId = new Map();
  for (const log of logs) {
    for (const event of log ?? []) {
      const existing = byId.get(event.id);
      byId.set(event.id, existing ? pickWinner(existing, event) : event);
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Live (non-tombstoned) events. Every projection should start here.
 *
 * @param {TimelineEvent[]} events
 * @returns {TimelineEvent[]}
 */
export function liveEvents(events) {
  return events.filter((e) => !e.deleted);
}
