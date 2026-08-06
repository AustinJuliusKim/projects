/**
 * Append-only event log in localStorage.
 *
 * Mirrors the local-first shape already proven in
 * apps/guided-repl/src/state/progressStore.js: storage is the source of
 * truth, every access is failure-tolerant, and sync (when it exists) is
 * fire-and-forget on top rather than in the way. Logging a meal must never be
 * blocked by a network — or by a full disk, or a browser with storage
 * disabled.
 */

const STORAGE_KEY = "bs:events";
const DEVICE_KEY = "bs:deviceId";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Stable per-browser id, minted once. Part of every event's provenance. */
export function deviceId() {
  const store = storage();
  if (!store) return "unknown-device";
  try {
    let id = store.getItem(DEVICE_KEY);
    if (!id) {
      id = globalThis.crypto.randomUUID();
      store.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "unknown-device";
  }
}

/** @returns {import("@baby/core").TimelineEvent[]} */
export function loadEvents() {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {import("@baby/core").TimelineEvent[]} events */
export function saveEvents(events) {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Quota or blocked storage. Nothing useful to do here — the in-memory
    // view still reflects the write, and sync will carry it if configured.
  }
}

/**
 * An ISO-8601 timestamp carrying this device's real UTC offset.
 *
 * `toISOString()` alone would give a `Z` instant, losing the local offset the
 * user actually logged in — and a naive local string would be rejected by the
 * schema (deliberately). This keeps the instant *and* the offset.
 *
 * @param {Date} [at]
 * @returns {string}
 */
export function isoWithOffset(at = new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offsetMin = -at.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const local = new Date(at.getTime() + offsetMin * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
}

/** IANA zone this device is in right now. */
export function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Appends one event. Returns the new log.
 *
 * @param {{babyId: string, kind: string, payload: object, at?: Date}} input
 * @returns {import("@baby/core").TimelineEvent[]}
 */
export function appendEvent({ babyId, kind, payload, at = new Date() }) {
  const now = isoWithOffset(at);
  /** @type {import("@baby/core").TimelineEvent} */
  const event = {
    id: globalThis.crypto.randomUUID(),
    babyId,
    ts: now,
    tz: currentTimeZone(),
    kind,
    payload,
    source: "baby-solids",
    deviceId: deviceId(),
    createdAt: isoWithOffset(),
    revision: 0,
    deleted: false,
  };
  const next = [...loadEvents(), event];
  saveEvents(next);
  return next;
}

/**
 * Appends several events in one action — the batch-logging path.
 *
 * A real meal is three or four foods at once, and making that three or four
 * separate interactions is the complaint that shows up most often about
 * existing trackers.
 *
 * @param {{babyId: string, kind: string, at?: Date}} common
 * @param {object[]} payloads
 */
export function appendEvents(common, payloads) {
  let log = loadEvents();
  const at = common.at ?? new Date();
  for (const payload of payloads) {
    log = appendEvent({ ...common, payload, at });
  }
  return log;
}

/**
 * Edits an event by bumping its revision — never by rewriting history.
 *
 * @param {string} id
 * @param {(e: import("@baby/core").TimelineEvent) => object} updatePayload
 */
export function editEvent(id, updatePayload) {
  const next = loadEvents().map((e) =>
    e.id === id
      ? { ...e, payload: updatePayload(e), revision: e.revision + 1, createdAt: isoWithOffset() }
      : e,
  );
  saveEvents(next);
  return next;
}

/**
 * Deletes by tombstone, never by removal.
 *
 * Dropping the event from the array would work fine on one device and be
 * silently undone on the next sync: the other device still holds it, and a
 * merge cannot tell "deleted" from "not seen yet". So the delete is a fact we
 * record, not a fact we erase.
 *
 * @param {string} id
 */
export function deleteEvent(id) {
  const next = loadEvents().map((e) =>
    e.id === id ? { ...e, deleted: true, revision: e.revision + 1, createdAt: isoWithOffset() } : e,
  );
  saveEvents(next);
  return next;
}

/** Test seam — replaces the whole log (used by import and sync). */
export function replaceEvents(events) {
  saveEvents(events);
  return events;
}
