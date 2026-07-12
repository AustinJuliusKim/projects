/**
 * Lesson-progress mirror: localStorage is the source of truth for the
 * anonymous learner, written through (fire-and-forget) to PUT /api/progress.
 * When signed in, the server copy hydrates/merges back — freshest updatedAt
 * wins per lesson, and "completed" never downgrades to "started".
 */

import { putProgress, getProgress } from "../api/client.js";

const STORAGE_KEY = "gr:progress";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @returns {Record<string, {status: string, updatedAt: string}>} */
export function loadLocal() {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, {status: string, updatedAt: string}>} progress */
function saveLocal(progress) {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage full/blocked: the server write-through still fires.
  }
}

/**
 * Pure merge: freshest updatedAt wins per lesson; a "completed" entry never
 * loses to a fresher "started" (completion is monotonic).
 *
 * @param {Record<string, {status: string, updatedAt: string}>} local
 * @param {Record<string, {status: string, updatedAt: string}>} remote
 */
export function mergeProgress(local, remote) {
  const merged = { ...local };
  for (const [lessonId, entry] of Object.entries(remote)) {
    const mine = merged[lessonId];
    if (!mine) {
      merged[lessonId] = entry;
      continue;
    }
    if (mine.status === "completed" && entry.status !== "completed") continue;
    if (entry.status === "completed" && mine.status !== "completed") {
      merged[lessonId] = entry;
      continue;
    }
    merged[lessonId] = new Date(entry.updatedAt) > new Date(mine.updatedAt) ? entry : mine;
  }
  return merged;
}

/**
 * Records a lesson status locally and writes through to the API
 * (fire-and-forget — offline is fine). Never downgrades completed→started.
 *
 * @param {string} lessonId
 * @param {"started"|"completed"} status
 * @param {{anonId?: string|null}} [opts]
 */
export function markLesson(lessonId, status, { anonId = null } = {}) {
  const progress = loadLocal();
  const current = progress[lessonId];
  if (current?.status === "completed" && status === "started") return progress;
  progress[lessonId] = { status, updatedAt: new Date().toISOString() };
  saveLocal(progress);
  putProgress(lessonId, { status, ...(anonId ? { anonId } : {}) });
  return progress;
}

/**
 * Hydrates from the server (session or anonId owner) and merges into the
 * local mirror. Resolves to the merged map; offline resolves to local as-is.
 *
 * @param {{anonId?: string|null}} [opts]
 */
export async function syncFromServer({ anonId = null } = {}) {
  const local = loadLocal();
  const res = await getProgress(anonId ? { anonId } : {});
  if (!res?.progress) return local;
  const remote = {};
  for (const row of res.progress) {
    remote[row.lesson_id] = { status: row.status, updatedAt: row.updated_at };
  }
  const merged = mergeProgress(local, remote);
  saveLocal(merged);
  return merged;
}
