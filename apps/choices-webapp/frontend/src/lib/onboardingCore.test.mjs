import test from "node:test";
import assert from "node:assert/strict";
import {
  ONBOARDING_VERSION,
  parseOnboarding,
  serializeOnboarding,
  onboardingSurface,
  decideOnboarding,
} from "./onboardingCore.mjs";

test("onboardingSurface maps Landing hashes to the full carousel", () => {
  for (const hash of ["", "#", "#/"]) {
    assert.equal(onboardingSurface(hash, false), "full", hash);
  }
});

test("onboardingSurface maps join hashes to the condensed card", () => {
  assert.equal(onboardingSurface("#/join", false), "condensed");
  assert.equal(onboardingSurface("#/join?code=PLUM-42", false), "condensed");
});

test("onboardingSurface is null on every other route (intent-loaded)", () => {
  for (const hash of [
    "#/create",
    "#/history",
    "#/premium",
    "#/settings",
    "#/cancel",
    "#/admin",
    "#/account",
  ]) {
    assert.equal(onboardingSurface(hash, false), null, hash);
  }
});

test("onboardingSurface is null on every hash mid-game", () => {
  for (const hash of ["", "#", "#/", "#/join", "#/join?code=PLUM-42", "#/create", "#/history"]) {
    assert.equal(onboardingSurface(hash, true), null, hash);
  }
});

test("parseOnboarding rejects garbage", () => {
  for (const raw of [null, "", "not json", "[]", "42", '"str"', "{}", '{"at":"nope"}', '{"v":1}']) {
    assert.equal(parseOnboarding(raw), null, String(raw));
  }
});

test("parseOnboarding accepts records, including unknown future versions", () => {
  assert.deepEqual(parseOnboarding('{"v":1,"at":5,"variant":"full"}'), {
    v: 1,
    at: 5,
    variant: "full",
  });
  // Never re-nag a user because the record format moved on.
  assert.ok(parseOnboarding('{"v":99,"at":5}'));
});

test("serialize/parse round-trip", () => {
  const rec = parseOnboarding(serializeOnboarding("condensed", 123));
  assert.deepEqual(rec, { v: ONBOARDING_VERSION, at: 123, variant: "condensed" });
});

const BASE = {
  surface: "full",
  record: null,
  flagOn: true,
  hydrated: true,
  signedIn: false,
  serverOnboarded: undefined,
};

test("decideOnboarding truth table", () => {
  // Flag off dominates everything.
  assert.equal(decideOnboarding({ ...BASE, flagOn: false }), "hide");
  // Unhydrated flags -> wait (the flag defaults off; no flash-in on override).
  assert.equal(decideOnboarding({ ...BASE, hydrated: false }), "wait");
  // No surface -> hide.
  assert.equal(decideOnboarding({ ...BASE, surface: null }), "hide");
  // A local record wins, even over a server that says not-onboarded.
  const record = { v: 1, at: 1, variant: "full" };
  assert.equal(decideOnboarding({ ...BASE, record }), "hide");
  assert.equal(
    decideOnboarding({ ...BASE, record, signedIn: true, serverOnboarded: false }),
    "hide"
  );
  // Guests decide synchronously.
  assert.equal(decideOnboarding(BASE), "show");
  // Signed-in: wait for the server answer; then honor it; fail open on null.
  assert.equal(decideOnboarding({ ...BASE, signedIn: true }), "wait");
  assert.equal(decideOnboarding({ ...BASE, signedIn: true, serverOnboarded: true }), "hide");
  assert.equal(decideOnboarding({ ...BASE, signedIn: true, serverOnboarded: false }), "show");
  assert.equal(decideOnboarding({ ...BASE, signedIn: true, serverOnboarded: null }), "show");
});
