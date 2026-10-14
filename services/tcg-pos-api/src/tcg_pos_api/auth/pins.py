"""Staff PINs for register sign-in and manager approvals (0012).

  * 6 digits; trivial PINs are refused (one digit repeated, a repeated 2- or
    3-digit block like 121212 / 123123, or a straight run up or down like
    123456 / 987654).
  * Stored as Argon2id (argon2-cffi's RFC 9106 low-memory profile), per
    store: staff_pin is keyed (tenant, user).
  * Lockout: the 5th consecutive failure locks the PIN for 1 minute, and
    each further failure doubles it (2, 4, ... capped at 1 hour). While
    locked the PIN isn't even checked. A success, or the owner of the PIN
    setting a new one, clears it.
  * Every failure is audit-logged (pin.fail), and callers rate-limit PIN
    attempts per register device (ratelimit.enforce) before calling
    check_pin. A PIN is only ever accepted through an enrolled, unrevoked
    device (routes/registers.py takes the device credential).

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
FREE_FAILURES = 5
LOCK_BASE_SECONDS = 60
LOCK_MAX_SECONDS = 3600
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
    """How long a PIN stays locked after its fail_count-th straight failure."""
    if fail_count < FREE_FAILURES:
        return 0
    return min(LOCK_BASE_SECONDS * 2 ** (fail_count - FREE_FAILURES), LOCK_MAX_SECONDS)


@dataclasses.dataclass(frozen=True)
class PinResult:
    ok: bool
    reason: str | None = None  # wrong_pin | pin_locked
    attempts_left: int | None = None
    retry_after: int | None = None


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
    """Check an active member's PIN in the transaction's store, with lockout
    bookkeeping and an audit row per failure (purpose: sign_in | approval)."""
    row = conn.execute(
        "SELECT p.pin_hash, p.fail_count, p.locked_until > now() AS locked, "
        "ceil(extract(epoch FROM p.locked_until - now()))::int AS retry "
        "FROM staff_pin p JOIN membership m ON m.tenant_id = p.tenant_id "
        "AND m.user_id = p.user_id AND m.status = 'active' "
        "WHERE p.user_id = %s FOR UPDATE OF p",
        (user_id,),
    ).fetchone()

    def fail(result: PinResult, fail_count: int | None) -> PinResult:
        queries.write_audit(
            conn,
            action="pin.fail",
            entity="staff_pin",
            entity_id=user_id,
            before=None,
            after={
                "device_id": device_id,
                "purpose": purpose,
                "reason": result.reason,
                "fail_count": fail_count,
            },
        )
        return result

    if row is None:
        _verify(_DUMMY_HASH, pin)
        return fail(PinResult(ok=False, reason="wrong_pin"), None)
    if row["locked"]:
        return fail(
            PinResult(ok=False, reason="pin_locked", attempts_left=0, retry_after=row["retry"]),
            row["fail_count"],
        )
    if _verify(row["pin_hash"], pin):
        updates = "fail_count = 0, locked_until = NULL"
        params: list = []
        if _hasher.check_needs_rehash(row["pin_hash"]):
            updates += ", pin_hash = %s, updated_at = now()"
            params.append(hash_pin(pin))
        if row["fail_count"] or params:
            conn.execute(f"UPDATE staff_pin SET {updates} WHERE user_id = %s", (*params, user_id))
        return PinResult(ok=True)
    count = row["fail_count"] + 1
    lock = lock_seconds(count)
    conn.execute(
        "UPDATE staff_pin SET fail_count = %s, locked_until = now() + %s WHERE user_id = %s",
        (count, datetime.timedelta(seconds=lock) if lock else None, user_id),
    )
    if lock:
        return fail(
            PinResult(ok=False, reason="pin_locked", attempts_left=0, retry_after=lock), count
        )
    return fail(PinResult(ok=False, reason="wrong_pin", attempts_left=FREE_FAILURES - count), count)


def pin_failure_response(result: PinResult) -> JSONResponse:
    """403 {"reason": "wrong_pin", "attempts_left": n} or 423 {"reason":
    "pin_locked", "retry_after": s} (+ Retry-After). Returned, not raised,
    so the failure count and audit row commit."""
    if result.reason == "pin_locked":
        retry = max(1, math.ceil(result.retry_after or 1))
        return JSONResponse(
            status_code=423,
            content={"detail": {"reason": "pin_locked", "retry_after": retry}},
            headers={"Retry-After": str(retry)},
        )
    detail: dict = {"reason": "wrong_pin"}
    if result.attempts_left is not None:
        detail["attempts_left"] = result.attempts_left
    return JSONResponse(status_code=403, content={"detail": detail})
