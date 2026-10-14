"""Staff, invites and roles for the selected store (staff.manage):

  GET    /v1/roles                 roles this store can assign, with perms
  GET    /v1/staff                 members (active and disabled)
  PATCH  /v1/staff/{user_id}       change role and/or status
  DELETE /v1/staff/{user_id}       disable (memberships are never deleted)
  POST   /v1/invites               invite an email address to a role
  GET    /v1/invites               invites, newest first, with status
  DELETE /v1/invites/{id}          revoke a pending invite
  POST   /v1/invites/accept        accept (signed in, no store selected)

Escalation rules, enforced here (and the last-owner rule by a trigger too):
  * a grantor can only assign a role whose permissions are a subset of their
    own, and only an owner can grant the owner role;
  * a grantor can only change, disable or revoke for someone whose current
    role they could themselves grant (a manager can't touch an owner);
  * nobody changes their own membership;
  * the last active owner can't be disabled or demoted.
Staff changes in one store are serialized by an advisory lock, so two
concurrent demotions can't both see "another owner is left".

Invite tokens are 32 random bytes; only their SHA-256 is stored. There is no
email delivery yet: in ENV=local/test the accept link is logged; elsewhere
only the invite id is logged (never the token) — wire SES before relying on
invites outside local dev."""

import datetime
import hashlib
import logging
import os
import secrets
import uuid
from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, HTTPException

from tcg_pos_api import queries
from tcg_pos_api.auth import Perm, Principal, TenantSession, UserConn, require
from tcg_pos_api.auth.dev import DEV_ENVS
from tcg_pos_api.config import env_name
from tcg_pos_api.routes.models import (
    Invite,
    InviteAccept,
    InviteAccepted,
    InviteCreate,
    Role,
    StaffMember,
    StaffUpdate,
)

logger = logging.getLogger("tcg_pos_api.invites")

router = APIRouter(tags=["staff"])

StaffSession = Annotated[TenantSession, require(Perm.STAFF_MANAGE)]

INVITE_TTL = datetime.timedelta(days=7)
OWNER = "owner"


# --- roles ----------------------------------------------------------------------

ROLE_SQL = (
    "SELECT r.id, r.key, r.name, r.is_system, "
    "ARRAY(SELECT rp.perm FROM role_permission rp WHERE rp.role_id = r.id ORDER BY rp.perm) "
    "AS perms FROM role r"
)


def find_role(conn: psycopg.Connection, key: str) -> dict[str, Any]:
    """The system or store role with this key (RLS hides other stores'; a
    store role can't reuse a system key, 0011), or 422."""
    row = conn.execute(f"{ROLE_SQL} WHERE r.key = %s", (key,)).fetchone()
    if row is None:
        raise HTTPException(422, f"no role named {key!r}")
    return row


def role_by_id(conn: psycopg.Connection, role_id: uuid.UUID) -> dict[str, Any]:
    return conn.execute(f"{ROLE_SQL} WHERE r.id = %s", (role_id,)).fetchone()


def _forbidden(reason: str, **extra: Any) -> HTTPException:
    return HTTPException(403, {"reason": reason, **extra})


def check_grantable(principal: Principal, role: dict[str, Any], *, verb: str = "grant") -> None:
    """403 unless `principal` may hand out (or act on holders of) `role`."""
    if role["is_system"] and role["key"] == OWNER and principal.role_key != OWNER:
        raise _forbidden(f"only an owner can {verb} the owner role")
    missing = sorted(set(role["perms"]) - principal.perms)
    if missing:
        raise _forbidden(
            f"you can't {verb} a role with permissions you don't have", missing=missing
        )


@router.get("/roles", response_model=list[Role])
def list_roles(session: StaffSession) -> list[Role]:
    rows = session.conn.execute(
        f"SELECT * FROM ({ROLE_SQL}) x ORDER BY is_system DESC, cardinality(perms) DESC, key"
    ).fetchall()
    return [Role(**r) for r in rows]


# --- staff ----------------------------------------------------------------------


def _lock_staff(conn: psycopg.Connection, tenant_id: uuid.UUID) -> None:
    conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"membership:{tenant_id}",)
    )


def _member(conn: psycopg.Connection, user_id: uuid.UUID) -> StaffMember | None:
    row = conn.execute("SELECT * FROM tenant_staff() WHERE user_id = %s", (user_id,)).fetchone()
    if row is None:
        return None
    return StaffMember(**{**row, "role": row["role_key"]})


@router.get("/staff", response_model=list[StaffMember])
def list_staff(session: StaffSession) -> list[StaffMember]:
    rows = session.conn.execute("SELECT * FROM tenant_staff()").fetchall()
    return [StaffMember(**{**r, "role": r["role_key"]}) for r in rows]


def _change_member(
    session: TenantSession, user_id: uuid.UUID, *, role_key: str | None, status: str | None
) -> StaffMember:
    conn, principal = session.conn, session.principal
    if user_id == principal.user_id:
        raise _forbidden("you can't change your own membership")
    _lock_staff(conn, principal.tenant_id)
    current = conn.execute(
        "SELECT m.role_id, m.status, r.key AS role_key FROM membership m "
        "JOIN role r ON r.id = m.role_id WHERE m.user_id = %s",
        (user_id,),
    ).fetchone()
    if current is None:
        raise HTTPException(404, "no staff member with that id")
    current_role = role_by_id(conn, current["role_id"])
    check_grantable(principal, current_role, verb="manage")
    new_role = find_role(conn, role_key) if role_key else current_role
    if role_key:
        check_grantable(principal, new_role)
    new_status = status or current["status"]
    if new_role["id"] == current["role_id"] and new_status == current["status"]:
        return _member(conn, user_id)

    losing_owner = (
        current["role_key"] == OWNER
        and current["status"] == "active"
        and (new_role["key"] != OWNER or new_status != "active")
    )
    if losing_owner:
        owners = conn.execute(
            "SELECT count(*) AS n FROM membership m JOIN role r ON r.id = m.role_id "
            "WHERE r.key = %s AND r.tenant_id IS NULL AND m.status = 'active'",
            (OWNER,),
        ).fetchone()["n"]
        if owners <= 1:
            raise HTTPException(409, "a store must keep at least one active owner")

    conn.execute(
        "UPDATE membership SET role_id = %s, status = %s, updated_at = now() WHERE user_id = %s",
        (new_role["id"], new_status, user_id),
    )
    queries.write_audit(
        conn,
        action="staff.update",
        entity="membership",
        entity_id=user_id,
        before={"role": current["role_key"], "status": current["status"]},
        after={"role": new_role["key"], "status": new_status},
    )
    return _member(conn, user_id)


@router.patch("/staff/{user_id}", response_model=StaffMember)
def update_staff(session: StaffSession, user_id: uuid.UUID, body: StaffUpdate) -> StaffMember:
    return _change_member(session, user_id, role_key=body.role, status=body.status)


@router.delete("/staff/{user_id}", response_model=StaffMember)
def disable_staff(session: StaffSession, user_id: uuid.UUID) -> StaffMember:
    """Disable a member. Memberships are never deleted (audit history keeps
    pointing at them); PATCH status=active re-enables."""
    return _change_member(session, user_id, role_key=None, status="disabled")


# --- invites --------------------------------------------------------------------

INVITE_SQL = (
    "SELECT i.id, i.email, i.role_id, r.key AS role, i.expires_at, i.accepted_at, i.accepted_by, "
    "i.revoked_at, i.invited_by, i.created_at, "
    "CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' "
    "WHEN i.accepted_at IS NOT NULL THEN 'accepted' "
    "WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END AS status "
    "FROM invite i JOIN role r ON r.id = i.role_id"
)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def accept_url(token: str) -> str:
    base = os.environ.get("APP_BASE_URL", "http://localhost:5173").rstrip("/")
    return f"{base}/invite?token={token}"


def deliver_invite(invite_id: uuid.UUID, email: str, token: str) -> None:
    """No email yet (SES is an A4 ops task). Locally, log the link."""
    if env_name() in DEV_ENVS:
        logger.info("invite %s for %s: %s", invite_id, email, accept_url(token))
    else:
        logger.warning("invite %s created but no invite email delivery is configured", invite_id)


@router.post("/invites", response_model=Invite, status_code=201)
def create_invite(session: StaffSession, body: InviteCreate) -> Invite:
    conn, principal = session.conn, session.principal
    role = find_role(conn, body.role)
    check_grantable(principal, role)
    _lock_staff(conn, principal.tenant_id)
    member = conn.execute(
        "SELECT status FROM tenant_staff() WHERE email = %s AND status = 'active'", (body.email,)
    ).fetchone()
    if member is not None:
        raise HTTPException(409, "that email already belongs to an active member")
    pending = conn.execute(
        "SELECT 1 FROM invite WHERE email = %s AND accepted_at IS NULL "
        "AND revoked_at IS NULL AND expires_at > now()",
        (body.email,),
    ).fetchone()
    if pending is not None:
        raise HTTPException(409, "that email already has a pending invite (revoke it first)")
    token = secrets.token_urlsafe(32)
    invite_id = conn.execute(
        "INSERT INTO invite (email, role_id, token_hash, expires_at, invited_by) "
        "VALUES (%s, %s, %s, now() + %s, %s) RETURNING id",
        (body.email, role["id"], token_hash(token), INVITE_TTL, principal.user_id),
    ).fetchone()["id"]
    queries.write_audit(
        conn,
        action="invite.create",
        entity="invite",
        entity_id=invite_id,
        before=None,
        after={"email": body.email, "role": role["key"]},
    )
    deliver_invite(invite_id, body.email, token)
    return Invite(**conn.execute(f"{INVITE_SQL} WHERE i.id = %s", (invite_id,)).fetchone())


@router.get("/invites", response_model=list[Invite])
def list_invites(session: StaffSession) -> list[Invite]:
    rows = session.conn.execute(f"{INVITE_SQL} ORDER BY i.created_at DESC, i.id LIMIT 500")
    return [Invite(**r) for r in rows]


@router.delete("/invites/{invite_id}", response_model=Invite)
def revoke_invite(session: StaffSession, invite_id: uuid.UUID) -> Invite:
    conn, principal = session.conn, session.principal
    invite = conn.execute(f"{INVITE_SQL} WHERE i.id = %s FOR UPDATE OF i", (invite_id,)).fetchone()
    if invite is None:
        raise HTTPException(404, "no invite with that id")
    check_grantable(principal, role_by_id(conn, invite["role_id"]), verb="manage")
    if invite["status"] in ("accepted", "revoked"):
        raise HTTPException(409, f"invite is already {invite['status']}")
    conn.execute("UPDATE invite SET revoked_at = now() WHERE id = %s", (invite_id,))
    queries.write_audit(
        conn,
        action="invite.revoke",
        entity="invite",
        entity_id=invite_id,
        before={"status": invite["status"]},
        after={"status": "revoked"},
    )
    return Invite(**conn.execute(f"{INVITE_SQL} WHERE i.id = %s", (invite_id,)).fetchone())


ACCEPT_ERRORS = {
    "not_found": (404, "no such invite"),
    "email_mismatch": (403, "this invite is for a different email address"),
    "revoked": (410, "this invite was revoked"),
    "expired": (410, "this invite has expired"),
    "used": (409, "this invite has already been used"),
    "already_member": (409, "you are already a member of that store"),
}


@router.post("/invites/accept", response_model=InviteAccepted)
def accept_invite(session: UserConn, body: InviteAccept) -> InviteAccepted:
    """Join the invite's store with its role. The invite's email must equal
    the caller's verified email (app_user.email, from the token / ID token —
    never from the request)."""
    row = session.conn.execute(
        "SELECT status, tenant_id, role_key FROM accept_invite(%s, %s)",
        (session.claims.sub, token_hash(body.token.strip())),
    ).fetchone()
    if row["status"] != "accepted":
        status, detail = ACCEPT_ERRORS[row["status"]]
        raise HTTPException(status, detail)
    return InviteAccepted(tenant_id=row["tenant_id"], role=row["role_key"])
