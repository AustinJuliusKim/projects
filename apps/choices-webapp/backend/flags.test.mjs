import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_DEFS,
  CACHE_TTL_MS,
  configureFlagsStore,
  isEnabled,
  publicFlags,
  listFlags,
  bustFlagsCache,
  _resetForTests,
} from "./flags.mjs";

// Injected fake ddb: counts reads, returns a programmable item (or throws).
function fakeStore(itemOrFn) {
  const store = {
    reads: 0,
    send: async () => {
      store.reads++;
      const v = typeof itemOrFn === "function" ? itemOrFn() : itemOrFn;
      return { Item: v };
    },
  };
  return store;
}

beforeEach(() => {
  _resetForTests();
});

test("isEnabled serves overrides and falls back to defaults", async () => {
  const store = fakeStore({
    pk: "FLAGS#global",
    flags: { ops_kill_fill4: { enabled: true, updatedAt: 1, updatedBy: "u" } },
    version: 3,
  });
  configureFlagsStore(store, "T");
  assert.equal(await isEnabled("ops_kill_fill4", 1000), true); // override wins
  assert.equal(await isEnabled("release_reveal_card", 1000), true); // def default
  assert.equal(await isEnabled("ops_kill_places", 1000), false); // def default
  assert.equal(await isEnabled("made_up_flag", 1000), false); // unknown => false
});

test("60s cache: one read inside the window, refetch after expiry", async () => {
  const store = fakeStore({ pk: "FLAGS#global", flags: {}, version: 1 });
  configureFlagsStore(store, "T");
  await isEnabled("ops_kill_places", 1000);
  await publicFlags(1000 + CACHE_TTL_MS - 1);
  assert.equal(store.reads, 1);
  await isEnabled("ops_kill_places", 1000 + CACHE_TTL_MS + 1);
  assert.equal(store.reads, 2);
});

test("store errors serve defaults and never throw", async () => {
  configureFlagsStore(
    { send: async () => { throw new Error("ddb down"); } },
    "T"
  );
  assert.equal(await isEnabled("release_reveal_card", 1000), true);
  const pub = await publicFlags(1000);
  assert.equal(pub.release_reveal_card, true);
});

test("publicFlags exposes ONLY public defs", async () => {
  configureFlagsStore(fakeStore(undefined), "T");
  const pub = await publicFlags(1000);
  const publicNames = Object.entries(FLAG_DEFS)
    .filter(([, d]) => d.public)
    .map(([n]) => n)
    .sort();
  assert.deepEqual(Object.keys(pub).sort(), publicNames);
  assert.ok(!("ops_kill_places" in pub));
  assert.ok(!("ops_kill_fill4" in pub));
});

test("listFlags merges overrides with defs and carries the item version", async () => {
  const store = fakeStore({
    pk: "FLAGS#global",
    flags: { release_reveal_card: { enabled: false, updatedAt: 7, updatedBy: "u-admin" } },
    version: 5,
  });
  configureFlagsStore(store, "T");
  const { flags, version } = await listFlags(1000);
  assert.equal(version, 5);
  assert.equal(flags.release_reveal_card.enabled, false);
  assert.equal(flags.release_reveal_card.default, true);
  assert.equal(flags.release_reveal_card.updatedBy, "u-admin");
  assert.equal(flags.ops_kill_places.enabled, false);
  assert.equal(flags.ops_kill_places.updatedAt, null);
});

test("bustFlagsCache forces the next read through the store", async () => {
  const store = fakeStore({ pk: "FLAGS#global", flags: {}, version: 1 });
  configureFlagsStore(store, "T");
  await isEnabled("ops_kill_places", 1000);
  bustFlagsCache();
  await isEnabled("ops_kill_places", 1001);
  assert.equal(store.reads, 2);
});
