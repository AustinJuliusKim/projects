import assert from "node:assert/strict";
import { test } from "node:test";

import { pageSlice, unloggedItems } from "../src/paging.js";

const ITEMS = Array.from({ length: 30 }, (_, i) => ({ oracle_id: `id-${i}` }));

test("pageSlice returns the requested page", () => {
  assert.deepEqual(pageSlice(ITEMS, 1, 25).map((i) => i.oracle_id), ITEMS.slice(0, 25).map((i) => i.oracle_id));
});

test("pageSlice handles a partial last page", () => {
  const page2 = pageSlice(ITEMS, 2, 25);
  assert.equal(page2.length, 5);
  assert.equal(page2[0].oracle_id, "id-25");
});

test("pageSlice returns empty past the last page", () => {
  assert.deepEqual(pageSlice(ITEMS, 3, 25), []);
});

test("pageSlice returns empty before the first page", () => {
  assert.deepEqual(pageSlice(ITEMS, 0, 25), []);
});

test("pageSlice handles an empty item list", () => {
  assert.deepEqual(pageSlice([], 1, 25), []);
  assert.deepEqual(pageSlice(undefined, 1, 25), []);
});

test("pageSlice rejects a non-positive page size", () => {
  assert.deepEqual(pageSlice(ITEMS, 1, 0), []);
});

test("unloggedItems dedupes against an already-logged set", () => {
  const logged = new Set(["id-0", "id-1"]);
  const remaining = unloggedItems(ITEMS.slice(0, 3), logged);
  assert.deepEqual(remaining.map((i) => i.oracle_id), ["id-2"]);
});

test("unloggedItems returns everything when nothing is logged yet", () => {
  const remaining = unloggedItems(ITEMS.slice(0, 3), new Set());
  assert.equal(remaining.length, 3);
});

test("unloggedItems returns nothing once everything is logged", () => {
  const logged = new Set(ITEMS.map((i) => i.oracle_id));
  assert.deepEqual(unloggedItems(ITEMS.slice(0, 3), logged), []);
});
