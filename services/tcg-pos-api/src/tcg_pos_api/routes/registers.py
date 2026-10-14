"""Registers, PINs, register sessions and approvals (docs/AUTH_PLAN.md A3).

Back office (bearer token + X-Tenant-Id):
  PUT    /v1/me/pin                       set my own 6-digit PIN (any member)
  GET    /v1/registers                    registers.manage
  POST   /v1/registers                    registers.manage  {location_id, name}
  POST   /v1/registers/{id}/enroll        registers.manage  -> device secret, once
  GET    /v1/registers/devices            registers.manage
  DELETE /v1/registers/devices/{id}       registers.manage  revoke + end its sessions

On the register (`Authorization: Device <device secret>`):
  GET    /v1/register/staff               who can sign in here (members with a PIN)
  POST   /v1/register/sessions            {user_id, pin} -> session token
and with `X-Register-Session: <token>` as well:
  DELETE /v1/register/sessions            sign out / lock
  POST   /v1/approvals                    a manager approves one request
                                          {perm, payload_hash, amount_cents,
                                           approver_user_id, pin}

PIN attempts (sign-in and approvals) are rate-limited per device
(REGISTER_PIN_LIMIT per minute), locked out per PIN (auth/pins.py) and
audit-logged when they fail. Failed attempts are RETURNED as responses, not
raised, so that bookkeeping commits."""

import datetime
import secrets
import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import JSONResponse

from tcg_pos_api import queries, ratelimit
from tcg_pos_api.auth import (
    DeviceConn,
    MemberSession,
    Perm,
    RegisterSession,
    TenantSession,
    require,
)
from tcg_pos_api.auth.approvals import APPROVAL_TTL_SECONDS, eligible_approver
from tcg_pos_api.auth.pins import (
    attempts_per_minute,
    check_pin,
    hash_pin,
    pin_failure_response,
    pin_problem,
)
from tcg_pos_api.auth.principal import (
    SESSION_IDLE_SECONDS,
    SESSION_TTL_SECONDS,
    member_grants,
    sha256_hex,
)
from tcg_pos_api.routes.models import (
    ApprovalCreate,
    ApprovalOut,
    DeviceEnrolled,
    PinSet,
    Register,
    RegisterCreate,
    RegisterDevice,
    RegisterSessionOut,
    RegisterSignIn,
    RegisterStaff,
)

router = APIRouter(tags=["registers"])

RegistersSession = Annotated[TenantSession, require(Perm.REGISTERS_MANAGE)]

DEVICE_SECRET_PREFIX = "tcgdev_"
SESSION_TOKEN_PREFIX = "tcgreg_"


# --- my PIN ---------------------------------------------------------------------


@router.put("/me/pin", status_code=204)
def set_my_pin(session: MemberSession, body: PinSet) -> Response:
    """Set (or replace) the caller's PIN for the selected store. Clears any
    lockout. Signed-in staff only — not over a register session."""
    problem = pin_problem(body.pin)
    if problem:
        raise HTTPException(422, problem)
    conn, principal = session.conn, session.principal
    existed = conn.execute(
        "SELECT 1 FROM staff_pin WHERE user_id = %s", (principal.user_id,)
    ).fetchone()
    conn.execute(
        "INSERT INTO staff_pin (user_id, pin_hash) VALUES (%s, %s) "
        "ON CONFLICT (tenant_id, user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, "
        "fail_count = 0, locked_until = NULL, updated_at = now()",
        (principal.user_id, hash_pin(body.pin)),
    )
    queries.write_audit(
        conn,
        action="pin.set",
        entity="staff_pin",
        entity_id=principal.user_id,
        before={"pin": "set" if existed else None},
        after={"pin": "set"},
    )
    return Response(status_code=204)


# --- registers and devices (back office) ----------------------------------------


@router.get("/registers", response_model=list[Register])
def list_registers(session: RegistersSession) -> list[Register]:
    rows = session.conn.execute(
        "SELECT id, location_id, name, created_at FROM register ORDER BY name, id"
    ).fetchall()
    return [Register(**r) for r in rows]


@router.post("/registers", response_model=Register, status_code=201)
def create_register(session: RegistersSession, body: RegisterCreate) -> Register:
    conn = session.conn
    if not queries.location_exists(conn, body.location_id):
        raise HTTPException(422, "no location with that id")
    row = conn.execute(
        "INSERT INTO register (location_id, name) VALUES (%s, %s) "
        "RETURNING id, location_id, name, created_at",
        (body.location_id, body.name),
    ).fetchone()
    queries.write_audit(
        conn,
        action="register.create",
        entity="register",
        entity_id=row["id"],
        before=None,
        after={"name": body.name, "location_id": body.location_id},
    )
    return Register(**row)


DEVICE_SQL = (
    "SELECT d.id, d.register_id, r.name AS register_name, "
    "CASE WHEN d.revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status, "
    "d.enrolled_by, d.enrolled_at, d.last_seen_at, d.revoked_at "
    "FROM register_device d JOIN register r ON r.id = d.register_id"
)


def _device(conn: psycopg.Connection, device_id: uuid.UUID) -> RegisterDevice | None:
    row = conn.execute(f"{DEVICE_SQL} WHERE d.id = %s", (device_id,)).fetchone()
    return RegisterDevice(**row) if row else None


@router.post("/registers/{register_id}/enroll", response_model=DeviceEnrolled, status_code=201)
def enroll_device(session: RegistersSession, register_id: uuid.UUID) -> DeviceEnrolled:
    """Enroll the browser/machine this is called from as `register_id`. The
    secret is returned once and stored only as a SHA-256."""
    conn = session.conn
    if conn.execute("SELECT 1 FROM register WHERE id = %s", (register_id,)).fetchone() is None:
        raise HTTPException(404, "no register with that id")
    secret = DEVICE_SECRET_PREFIX + secrets.token_urlsafe(32)
    device_id = conn.execute(
        "INSERT INTO register_device (register_id, secret_hash) VALUES (%s, %s) RETURNING id",
        (register_id, sha256_hex(secret)),
    ).fetchone()["id"]
    queries.write_audit(
        conn,
        action="register.enroll",
        entity="register_device",
        entity_id=device_id,
        before=None,
        after={"register_id": register_id},
    )
    return DeviceEnrolled(device=_device(conn, device_id), device_secret=secret)


@router.get("/registers/devices", response_model=list[RegisterDevice])
def list_devices(session: RegistersSession) -> list[RegisterDevice]:
    rows = session.conn.execute(
        f"{DEVICE_SQL} ORDER BY d.revoked_at IS NOT NULL, r.name, d.enrolled_at DESC"
    ).fetchall()
    return [RegisterDevice(**r) for r in rows]


@router.delete("/registers/devices/{device_id}", response_model=RegisterDevice)
def revoke_device(session: RegistersSession, device_id: uuid.UUID) -> RegisterDevice:
    """Revoke a device: its secret stops working on the next request, and
    every open session on it ends."""
    conn = session.conn
    row = conn.execute(
        "SELECT revoked_at FROM register_device WHERE id = %s FOR UPDATE", (device_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "no register device with that id")
    if row["revoked_at"] is not None:
        raise HTTPException(409, "that device is already revoked")
    conn.execute("UPDATE register_device SET revoked_at = now() WHERE id = %s", (device_id,))
    ended = conn.execute(
        "UPDATE register_session SET ended_at = now() WHERE device_id = %s AND ended_at IS NULL",
        (device_id,),
    ).rowcount
    queries.write_audit(
        conn,
        action="register.revoke",
        entity="register_device",
        entity_id=device_id,
        before={"status": "active"},
        after={"status": "revoked", "sessions_ended": ended},
    )
    return _device(conn, device_id)


# --- on the register --------------------------------------------------------------


def _display_name(row: dict) -> str:
    if row.get("display_name"):
        return row["display_name"]
    if row.get("email"):
        return row["email"].split("@")[0]
    return str(row["user_id"])[:8]


@router.get("/register/staff", response_model=list[RegisterStaff])
def register_staff(device: DeviceConn) -> list[RegisterStaff]:
    """The staff picker: active members of this register's store who have
    set a PIN."""
    rows = device.conn.execute(
        "SELECT s.user_id, s.email, s.display_name, s.role_key FROM tenant_staff() s "
        "JOIN staff_pin p ON p.user_id = s.user_id WHERE s.status = 'active'"
    ).fetchall()
    staff = [
        RegisterStaff(user_id=r["user_id"], name=_display_name(r), role=r["role_key"]) for r in rows
    ]
    return sorted(staff, key=lambda s: (s.name.lower(), str(s.user_id)))


def _limit_pin_attempts(device_id: uuid.UUID) -> None:
    ratelimit.enforce(f"pin:device:{device_id}", attempts_per_minute())


@router.post("/register/sessions", response_model=RegisterSessionOut, status_code=201)
def sign_in(device: DeviceConn, body: RegisterSignIn):
    """Sign a staff member in on this register with their PIN."""
    _limit_pin_attempts(device.device_id)
    conn = device.conn
    result = check_pin(
        conn, user_id=body.user_id, pin=body.pin, device_id=device.device_id, purpose="sign_in"
    )
    if not result.ok:
        return pin_failure_response(result)
    grants = member_grants(conn, body.user_id)
    token = SESSION_TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = conn.execute(
        "INSERT INTO register_session (device_id, user_id, token_hash, expires_at) "
        "VALUES (%s, %s, %s, now() + %s) RETURNING id, expires_at",
        (
            device.device_id,
            body.user_id,
            sha256_hex(token),
            datetime.timedelta(seconds=SESSION_TTL_SECONDS),
        ),
    ).fetchone()
    queries.write_audit(
        conn,
        action="register.sign_in",
        entity="register_session",
        entity_id=row["id"],
        before=None,
        after={"user_id": body.user_id, "device_id": device.device_id},
    )
    person = conn.execute(
        "SELECT user_id, email, display_name FROM tenant_staff() WHERE user_id = %s",
        (body.user_id,),
    ).fetchone()
    return RegisterSessionOut(
        session_id=row["id"],
        session_token=token,
        user_id=body.user_id,
        name=_display_name(person),
        role=grants["role_key"],
        perms=list(grants["perms"]),
        expires_at=row["expires_at"],
        idle_timeout_seconds=SESSION_IDLE_SECONDS,
    )


@router.delete("/register/sessions", status_code=204)
def sign_out(session: RegisterSession) -> Response:
    """End the current register session (sign out / lock the register)."""
    principal = session.principal
    session.conn.execute(
        "UPDATE register_session SET ended_at = now() WHERE id = %s", (principal.session_id,)
    )
    queries.write_audit(
        session.conn,
        action="register.sign_out",
        entity="register_session",
        entity_id=principal.session_id,
        before=None,
        after={"user_id": principal.user_id},
    )
    return Response(status_code=204)


@router.post("/approvals", response_model=ApprovalOut, status_code=201)
def create_approval(session: RegisterSession, body: ApprovalCreate):
    """A manager approves one specific request for the signed-in user: the
    perm, payload_hash and amount_cents from the 403 approval_required
    response. Valid for 60 s, once, on this device, for this user."""
    try:
        perm = Perm(body.perm)
    except ValueError:
        raise HTTPException(422, f"unknown permission {body.perm!r}") from None
    conn, principal = session.conn, session.principal
    if body.approver_user_id == principal.user_id:
        raise HTTPException(403, {"reason": "self_approval"})
    _limit_pin_attempts(principal.device_id)
    result = check_pin(
        conn,
        user_id=body.approver_user_id,
        pin=body.pin,
        device_id=principal.device_id,
        purpose="approval",
    )
    if not result.ok:
        return pin_failure_response(result)
    if not eligible_approver(conn, body.approver_user_id, principal.user_id, perm):
        return JSONResponse(
            status_code=403,
            content={"detail": {"reason": "approver_not_allowed", "perm": perm.value}},
        )
    row = conn.execute(
        "INSERT INTO approval (perm, payload_hash, amount_cents, approved_by, device_id, "
        "expires_at) VALUES (%s, %s, %s, %s, %s, now() + %s) RETURNING id, expires_at",
        (
            perm.value,
            body.payload_hash,
            body.amount_cents,
            body.approver_user_id,
            principal.device_id,
            datetime.timedelta(seconds=APPROVAL_TTL_SECONDS),
        ),
    ).fetchone()
    queries.write_audit(
        conn,
        action="approval.create",
        entity="approval",
        entity_id=row["id"],
        before=None,
        after={
            "perm": perm.value,
            "amount_cents": body.amount_cents,
            "approved_by": body.approver_user_id,
        },
    )
    return ApprovalOut(
        approval_id=row["id"],
        perm=perm.value,
        amount_cents=body.amount_cents,
        approved_by=body.approver_user_id,
        expires_at=row["expires_at"],
    )
