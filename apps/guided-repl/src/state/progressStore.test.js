import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadLocal, markLesson, mergeProgress, syncFromServer } from "./progressStore.js";

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

beforeEach(() => {
  globalThis.localStorage = makeStorage();
  // No backend: every fetch fails — the store must keep working locally.
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
});

test("markLesson mirrors locally even when the API is unreachable", () => {
  markLesson("l1", "started", { anonId: "a" });
  assert.equal(loadLocal().l1.status, "started");

  markLesson("l1", "completed");
  assert.equal(loadLocal().l1.status, "completed");
});

test("markLesson never downgrades completed to started", () => {
  markLesson("l1", "completed");
  markLesson("l1", "started");
  assert.equal(loadLocal().l1.status, "completed");
});

test("mergeProgress: freshest wins, completion is monotonic", () => {
  const local = {
    l1: { status: "completed", updatedAt: "2026-07-01T00:00:00Z" },
    l2: { status: "started", updatedAt: "2026-07-05T00:00:00Z" },
    l3: { status: "started", updatedAt: "2026-07-01T00:00:00Z" },
  };
  const remote = {
    l1: { status: "started", updatedAt: "2026-07-10T00:00:00Z" }, // fresher but no downgrade
    l2: { status: "completed", updatedAt: "2026-07-02T00:00:00Z" }, // older but completed wins
    l3: { status: "started", updatedAt: "2026-07-03T00:00:00Z" }, // fresher started wins
    l4: { status: "completed", updatedAt: "2026-07-01T00:00:00Z" }, // remote-only
  };
  const merged = mergeProgress(local, remote);
  assert.equal(merged.l1.status, "completed");
  assert.equal(merged.l2.status, "completed");
  assert.equal(merged.l3.updatedAt, "2026-07-03T00:00:00Z");
  assert.equal(merged.l4.status, "completed");
});

test("syncFromServer merges the server rows into the local mirror", async () => {
  markLesson("l1", "started");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        progress: [{ lesson_id: "l2", status: "completed", updated_at: "2026-07-01T00:00:00Z" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const merged = await syncFromServer();
  assert.equal(merged.l1.status, "started");
  assert.equal(merged.l2.status, "completed");
  assert.equal(loadLocal().l2.status, "completed");
});

test("syncFromServer offline resolves to the local mirror unchanged", async () => {
  markLesson("l1", "completed");
  const merged = await syncFromServer({ anonId: "a" });
  assert.equal(merged.l1.status, "completed");
});
