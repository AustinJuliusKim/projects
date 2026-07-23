import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_FLAG_DEFAULTS,
  initialFlagsState,
  hydrateFlagsState,
  resolveFlag,
} from "./flagsCore.mjs";

test("initial state serves defaults, unhydrated", () => {
  const s = initialFlagsState();
  assert.equal(s.hydrated, false);
  assert.equal(resolveFlag(s, "release_reveal_card"), true);
  assert.equal(resolveFlag(s, "release_realtime_subscribe"), false);
});

test("hydrate merges server values over defaults and keeps unknowns", () => {
  const s = hydrateFlagsState(initialFlagsState(), {
    release_reveal_card: false,
    exp_new_thing: true,
    bogus: "not-a-bool",
  });
  assert.equal(s.hydrated, true);
  assert.equal(resolveFlag(s, "release_reveal_card"), false);
  assert.equal(resolveFlag(s, "exp_new_thing"), true);
  assert.equal(resolveFlag(s, "bogus", false), false); // non-bool ignored
});

test("malformed payloads leave defaults intact but mark hydrated", () => {
  for (const bad of [null, undefined, [1], "x"]) {
    const s = hydrateFlagsState(initialFlagsState(), bad);
    assert.equal(s.hydrated, true);
    assert.deepEqual(s.flags, { ...CLIENT_FLAG_DEFAULTS });
  }
});

test("resolveFlag fallback order: state > caller fallback > default > false", () => {
  const s = initialFlagsState();
  assert.equal(resolveFlag(s, "unknown_flag", true), true); // caller fallback
  assert.equal(resolveFlag(s, "unknown_flag"), false); // no fallback, no default
  assert.equal(resolveFlag(null, "release_reveal_card"), true); // built-in default
  assert.equal(resolveFlag(null, "nope"), false);
});
