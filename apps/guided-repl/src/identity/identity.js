/**
 * Anonymous identity + captured display name, mirrored in localStorage.
 *
 * `gr:anonId` keys progress/leads for anonymous learners (merged into the
 * user's account at magic-link verification). `gr:userName` only ever holds
 * a sanitizeUserName-approved value — the raw capture input is never stored.
 * All storage access is try/catch-swallowed so private-mode/blocked storage
 * degrades to the anonymous defaults instead of breaking the lesson.
 */

import { sanitizeUserName } from "@guided-repl/protocol";

const ANON_ID_KEY = "gr:anonId";
const USER_NAME_KEY = "gr:userName";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the stable anonymous id, creating and persisting one on first use.
 *
 * @returns {string|null} the anon id, or null when storage is unavailable
 */
export function ensureAnonId() {
  const store = storage();
  if (!store) return null;
  try {
    let id = store.getItem(ANON_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      store.setItem(ANON_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * @returns {string|null} the stored (re-sanitized) user name, or null
 */
export function getUserName() {
  const store = storage();
  if (!store) return null;
  try {
    return sanitizeUserName(store.getItem(USER_NAME_KEY));
  } catch {
    return null;
  }
}

/**
 * Sanitizes and persists a captured name. Invalid input stores nothing.
 *
 * @param {unknown} raw
 * @returns {string|null} the sanitized name that was stored, or null
 */
export function setUserName(raw) {
  const name = sanitizeUserName(raw);
  if (!name) return null;
  const store = storage();
  try {
    store?.setItem(USER_NAME_KEY, name);
  } catch {
    // Storage full/blocked: the in-memory value still personalizes this session.
  }
  return name;
}
