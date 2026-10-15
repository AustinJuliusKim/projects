"""Staff PINs for register sign-in and manager approvals (0012).

  * 6 digits; trivial PINs are refused (one digit repeated, a repeated 2- or
    3-digit block like 121212 / 123123, or a straight run up or down like
    123456 / 987654).
  * Stored as Argon2id (argon2-cffi's RFC 9106 low-memory profile), per
    store: staff_pin is keyed (tenant, user).
  * Lockout is per register device (0015 staff_pin_device): the 5th
    consecutive failure on a device locks the PIN *on that device* for 1
    minute, and each further failure there doubles it (2, 4, ... capped at
    1 hour). So one register can't lock someone out of the others.
  * A store-wide ceiling (staff_pin.fail_count / fail_devices) bounds
    guessing spread over several devices: from the 11th consecutive failure
    across at least two devices, every failure locks the PIN on all devices
    for an hour. Total guessing therefore stays at the old per-person rate
    (docs/AUTH_PLAN.md has the arithmetic). While locked (either scope) the
    PIN isn't even checked. A success resets the store-wide count and that
    device's; the owner of the PIN setting a new one resets everything.
  * Every failure is audit-logged (pin.fail), every lock too (pin.lock,
    with its scope), and callers rate-limit PIN attempts per register
    device (ratelimit.enforce) before calling check_pin. A PIN is only ever
    accepted through an enrolled, unrevoked device (routes/registers.py
    takes the device credential).

check_pin writes its bookkeeping in the request's transaction, so routes
report a failed attempt by RETURNING a response (pin_failure_response)
rather than raising: raising would roll the failure count back."""

import dataclasses
import datetime
import math
import os
import re
import uuid

import psycopg
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi.responses import JSONResponse

from tcg_pos_api import queries

PIN_RE = re.compile(r"^[0-9]{6}$")
# Per (person, device): the 5th straight failure on a device locks the PIN
# there for 1 minute, doubling per further failure, capped at 1 hour.
FREE_FAILURES = 5
LOCK_BASE_SECONDS = 60
LOCK_MAX_SECONDS = 3600
# Store-wide ceiling: from the 11th straight failure across at least two
# devices, each failure locks the PIN on every device for an hour.
STORE_FREE_FAILURES = 11
STORE_MIN_DEVICES = 2
STORE_LOCK_SECONDS = 3600
DEFAULT_ATTEMPTS_PER_MINUTE = 10

_hasher = PasswordHasher()
# Verified against when the user has no PIN, so "no such PIN" costs the same
# time as a wrong one.
_DUMMY_HASH = _hasher.hash("000000")


def attempts_per_minute() -> int:
    """PIN attempts allowed per register device per minute (REGISTER_PIN_LIMIT)."""
    return int(os.environ.get("REGISTER_PIN_LIMIT", DEFAULT_ATTEMPTS_PER_MINUTE))


def pin_problem(pin: str) -> str | None:
    """Why `pin` is unacceptable, or None."""
    if not PIN_RE.match(pin):
        return "a PIN is exactly 6 digits"
    for block in (1, 2, 3):
        if pin == pin[:block] * (6 // block):
            return "that PIN is too easy to guess (repeated digits)"
    steps = {int(b) - int(a) for a, b in zip(pin, pin[1:], strict=False)}
    if steps in ({1}, {-1}):
        return "that PIN is too easy to guess (a run of digits)"
    return None


def hash_pin(pin: str) -> str:
    return _hasher.hash(pin)


def lock_seconds(fail_count: int) -> int:
    """How long a PIN stays locked on one device after its fail_count-th
    straight failure there."""
    if fail_count < FREE_FAILURES:
        return 0
    return min(LOCK_BASE_SECONDS * 2 ** (fail_count - FREE_FAILURES), LOCK_MAX_SECONDS)


def store_lock_seconds(fail_count: int, devices: int) -> int:
    """How long a PIN stays locked on every device of the store after its
    fail_count-th straight failure, `devices` being how many devices those
    failures came from. One device alone never trips it."""
    if fail_count < STORE_FREE_FAILURES or devices < STORE_MIN_DEVICES:
        return 0
    return STORE_LOCK_SECONDS


@dataclasses.dataclass(frozen=True)
class PinResult:
    ok: bool
    reason: str | None = None  # wrong_pin | pin_locked
    attempts_left: int | None = None
    retry_after: int | None = None
    scope: str | None = None  # pin_locked: device | store


def _verify(pin_hash: str, pin: str) -> bool:
    try:
        return _hasher.verify(pin_hash, pin)
    except VerifyMismatchError:
        return False
    except (VerificationError, InvalidHashError):
        return False


def check_pin(
    conn: psycopg.Connection,
    *,
    user_id: uuid.UUID,
    pin: str,
    device_id: uuid.UUID,
    purpose: str,
) -> PinResult:
    """Check an active member's PIN in the transaction's store, entered on
    `device_id`, with lockout bookkeeping (per device, and the store-wide
    ceiling) and an audit row per failure (purpose: sign_in | approval) and
    per lock (pin.lock)."""
    row = conn.execute(
        "SELECT p.pin_hash, p.fail_count, p.fail_devices, p.locked_until > now() AS locked, "
        "ceil(extract(epoch FROM p.locked_until - now()))::int AS retry "
        "FROM staff_pin p JOIN membership m ON m.tenant_id = p.tenant_id "
        "AND m.user_id = p.user_id AND m.status = 'active' "
        "WHERE p.user_id = %s FOR UPDATE OF p",
        (user_id,),
    ).fetchone()

    def audit(action: str, after: dict) -> None:
        queries.write_audit(
            conn,
            action=action,
            entity="staff_pin",
            entity_id=user_id,
            before=None,
            after={"device_id": device_id, "purpose": purpose, **after},
        )

    def fail(result: PinResult, **counts) -> PinResult:
        audit("pin.fail", {"reason": result.reason, "scope": result.scope, **counts})
        return result

    if row is None:
        _verify(_DUMMY_HASH, pin)
        return fail(PinResult(ok=False, reason="wrong_pin"), fail_count=None)
    # The row lock on staff_pin above serializes this user's attempts across
    # devices, so the per-device row can be read and written plainly.
    dev = conn.execute(
        "SELECT fail_count, locked_until > now() AS locked, "
        "ceil(extract(epoch FROM locked_until - now()))::int AS retry "
        "FROM staff_pin_device WHERE user_id = %s AND device_id = %s",
        (user_id, device_id),
    ).fetchone()
    dev_count = dev["fail_count"] if dev else 0
    if row["locked"]:
        return fail(
            _locked(row["retry"], "store"),
            fail_count=row["fail_count"],
            device_fail_count=dev_count,
        )
    if dev and dev["locked"]:
        return fail(
            _locked(dev["retry"], "device"),
            fail_count=row["fail_count"],
            device_fail_count=dev_count,
        )

    if _verify(row["pin_hash"], pin):
        updates = "fail_count = 0, locked_until = NULL, fail_devices = '{}'"
        params: list = []
        if _hasher.check_needs_rehash(row["pin_hash"]):
            updates += ", pin_hash = %s, updated_at = now()"
            params.append(hash_pin(pin))
        if row["fail_count"] or row["fail_devices"] or params:
            conn.execute(f"UPDATE staff_pin SET {updates} WHERE user_id = %s", (*params, user_id))
        if dev_count:
            conn.execute(
                "UPDATE staff_pin_device SET fail_count = 0, locked_until = NULL, "
                "updated_at = now() WHERE user_id = %s AND device_id = %s",
                (user_id, device_id),
            )
        return PinResult(ok=True)

    # A miss: count it on this device and store-wide.
    dev_count += 1
    dev_lock = lock_seconds(dev_count)
    conn.execute(
        "INSERT INTO staff_pin_device (user_id, device_id, fail_count, locked_until) "
        "VALUES (%s, %s, %s, now() + %s) ON CONFLICT (tenant_id, user_id, device_id) "
        "DO UPDATE SET fail_count = EXCLUDED.fail_count, locked_until = EXCLUDED.locked_until, "
        "updated_at = now()",
        (user_id, device_id, dev_count, _interval(dev_lock)),
    )
    store_count = row["fail_count"] + 1
    devices = set(row["fail_devices"]) | {device_id}
    store_lock = store_lock_seconds(store_count, len(devices))
    conn.execute(
        "UPDATE staff_pin SET fail_count = %s, fail_devices = %s, locked_until = now() + %s "
        "WHERE user_id = %s",
        (store_count, sorted(devices), _interval(store_lock), user_id),
    )
    counts = {"fail_count": store_count, "device_fail_count": dev_count}
    for scope, seconds in (("device", dev_lock), ("store", store_lock)):
        if seconds:
            audit("pin.lock", {"scope": scope, "seconds": seconds, **counts})
    if store_lock or dev_lock:
        scope = "store" if store_lock >= dev_lock else "device"
        return fail(_locked(max(store_lock, dev_lock), scope), **counts)
    left = min(FREE_FAILURES - dev_count, STORE_FREE_FAILURES - store_count)
    return fail(PinResult(ok=False, reason="wrong_pin", attempts_left=max(left, 1)), **counts)


def _interval(seconds: int) -> datetime.timedelta | None:
    return datetime.timedelta(seconds=seconds) if seconds else None


def _locked(retry: int | None, scope: str) -> PinResult:
    return PinResult(ok=False, reason="pin_locked", attempts_left=0, retry_after=retry, scope=scope)


def pin_failure_response(result: PinResult) -> JSONResponse:
    """403 {"reason": "wrong_pin", "attempts_left": n} or 423 {"reason":
    "pin_locked", "retry_after": s, "scope": "device"|"store"} (+
    Retry-After). Returned, not raised,
    so the failure count and audit row commit."""
    if result.reason == "pin_locked":
        retry = max(1, math.ceil(result.retry_after or 1))
        return JSONResponse(
            status_code=423,
            content={
                "detail": {"reason": "pin_locked", "retry_after": retry, "scope": result.scope}
            },
            headers={"Retry-After": str(retry)},
        )
    detail: dict = {"reason": "wrong_pin"}
    if result.attempts_left is not None:
        detail["attempts_left"] = result.attempts_left
    return JSONResponse(status_code=403, content={"detail": detail})
