// Register mode helpers: the PIN pad, PIN failure handling and the idle
// auto-lock timer (pure; timers and clock are injectable for tests).

export const PIN_LENGTH = 6;

// The PIN pad's value after a key: a digit, "back" or "clear".
export function pinKey(value, key) {
  const v = String(value || "");
  if (key === "clear") return "";
  if (key === "back") return v.slice(0, -1);
  if (/^[0-9]$/.test(key) && v.length < PIN_LENGTH) return v + key;
  return v;
}

// What the lock screen shows after a failed PIN sign-in / approval:
// { message, attemptsLeft, lockedUntil } — lockedUntil (ms) when the PIN is
// locked (423 pin_locked) or the device is rate-limited (429), so the pad
// can count down and stay disabled.
export function pinFailure(err, now = Date.now()) {
  const d = err && err.detail && typeof err.detail === "object" ? err.detail : {};
  let wait = null;
  if (err && err.status === 423) wait = d.retry_after ?? err.retryAfter ?? 60;
  else if (err && err.status === 429) wait = err.retryAfter ?? 60;
  return {
    message: (err && err.message) || "Sign-in failed.",
    attemptsLeft: typeof d.attempts_left === "number" ? d.attempts_left : null,
    lockedUntil: wait !== null ? now + wait * 1000 : null,
  };
}

export function secondsLeft(until, now = Date.now()) {
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

// Calls onIdle once after `timeoutMs` without touch(). touch() is cheap
// (records the time), so it can run on every pointer/key event; the timer
// only reschedules when it fires early. The server enforces its own idle
// timeout too (session_idle), this just locks the screen promptly.
export function createIdleTimer({
  timeoutMs,
  onIdle,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
}) {
  let last = now();
  let handle = null;
  let stopped = false;

  function schedule(ms) {
    handle = setTimer(check, Math.max(0, ms));
  }
  function check() {
    handle = null;
    if (stopped) return;
    const idle = now() - last;
    if (idle >= timeoutMs) {
      stopped = true;
      onIdle();
    } else {
      schedule(timeoutMs - idle);
    }
  }
  schedule(timeoutMs);

  return {
    touch() {
      last = now();
    },
    stop() {
      stopped = true;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
    remainingMs() {
      return Math.max(0, timeoutMs - (now() - last));
    },
  };
}

// The device record kept in localStorage after POST /v1/registers/{id}/enroll.
export function deviceFromEnrollment(enrolled, { register, tenantId, storeName } = {}) {
  return {
    secret: enrolled.device_secret,
    deviceId: enrolled.device.id,
    registerId: enrolled.device.register_id,
    registerName: enrolled.device.register_name,
    locationId: register ? register.location_id : null,
    tenantId: tenantId || null,
    storeName: storeName || null,
  };
}
