import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ensureAnonId, getUserName, setUserName } from "./identity.js";

/** Minimal localStorage stand-in for the node test environment. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

beforeEach(() => {
  globalThis.localStorage = makeStorage();
});

test("ensureAnonId creates a UUID once and returns the same id after", () => {
  const id = ensureAnonId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(ensureAnonId(), id);
});

test("setUserName stores only sanitized values", () => {
  assert.equal(setUserName("  Ada   Lovelace "), "Ada Lovelace");
  assert.equal(getUserName(), "Ada Lovelace");

  assert.equal(setUserName("<script>x</script>"), null);
  // Invalid input never overwrites the stored name.
  assert.equal(getUserName(), "Ada Lovelace");
});

test("getUserName is null when nothing is stored", () => {
  assert.equal(getUserName(), null);
});

test("getUserName re-sanitizes tampered storage", () => {
  globalThis.localStorage.setItem("gr:userName", "<img onerror=x>");
  assert.equal(getUserName(), null);
});

test("storage unavailable degrades to null instead of throwing", () => {
  delete globalThis.localStorage;
  assert.equal(ensureAnonId(), null);
  assert.equal(getUserName(), null);
  assert.equal(setUserName("Ada"), "Ada");
});
