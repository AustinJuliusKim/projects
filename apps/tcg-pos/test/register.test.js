import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/api.js";
import {
  createIdleTimer,
  deviceFromEnrollment,
  pinFailure,
  pinKey,
  secondsLeft,
} from "../src/register.js";

test("pinKey: digits up to 6, back, clear", () => {
  let v = "";
  for (const k of ["1", "2", "x", "3", "4", "5", "6", "7"]) v = pinKey(v, k);
  assert.equal(v, "123456");
  assert.equal(pinKey(v, "back"), "12345");
  assert.equal(pinKey(v, "clear"), "");
});

test("pinFailure: attempts left, lockout and rate-limit countdowns", () => {
  const now = 1_000_000;
  const wrong = pinFailure(new ApiError(403, { detail: { reason: "wrong_pin", attempts_left: 2 } }), now);
  assert.equal(wrong.attemptsLeft, 2);
  assert.equal(wrong.lockedUntil, null);
  assert.match(wrong.message, /2 attempts left/);
  const locked = pinFailure(
    new ApiError(423, { detail: { reason: "pin_locked", retry_after: 60 } }, { retryAfter: 60 }),
    now,
  );
  assert.equal(locked.lockedUntil, now + 60_000);
  assert.equal(secondsLeft(locked.lockedUntil, now + 1500), 59);
  assert.equal(secondsLeft(locked.lockedUntil, now + 61_000), 0);
  const limited = pinFailure(new ApiError(429, { detail: "too many requests" }, { retryAfter: 17 }), now);
  assert.equal(limited.lockedUntil, now + 17_000);
  assert.equal(secondsLeft(null), 0);
});

function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

test("idle timer locks after the timeout without activity", () => {
  const clock = fakeClock();
  let idled = 0;
  const timer = createIdleTimer({ timeoutMs: 1000, onIdle: () => (idled += 1), ...clock });
  clock.advance(600);
  timer.touch(); // activity pushes the deadline to 1600
  clock.advance(600);
  assert.equal(idled, 0);
  assert.equal(timer.remainingMs(), 400);
  clock.advance(400);
  assert.equal(idled, 1);
  clock.advance(5000);
  assert.equal(idled, 1); // once
});

test("idle timer stop cancels it", () => {
  const clock = fakeClock();
  let idled = 0;
  const timer = createIdleTimer({ timeoutMs: 1000, onIdle: () => (idled += 1), ...clock });
  timer.stop();
  assert.equal(clock.pending(), 0);
  clock.advance(5000);
  assert.equal(idled, 0);
});

test("deviceFromEnrollment keeps what register mode needs", () => {
  const d = deviceFromEnrollment(
    {
      device: { id: "d1", register_id: "r1", register_name: "Front" },
      device_secret: "tcgdev_s",
    },
    { register: { id: "r1", location_id: "l1" }, tenantId: "t1", storeName: "Demo" },
  );
  assert.deepEqual(d, {
    secret: "tcgdev_s",
    deviceId: "d1",
    registerId: "r1",
    registerName: "Front",
    locationId: "l1",
    tenantId: "t1",
    storeName: "Demo",
  });
});
