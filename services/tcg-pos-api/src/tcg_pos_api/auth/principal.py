"""Who is calling, resolved per request inside the request's one transaction.

Store routes (Session / require) accept one of these credentials in
`Authorization`:

  Bearer <access token>   a signed-in person (Cognito; the dev issuer
                          locally). X-Tenant-Id selects WHICH of their stores
                          the request is for — only a selector, never
                          trusted on its own. resolve_principal(sub, tenant)
                          reads their active membership, role and
                          permissions from Postgres; no row -> 403, the same
                          whether the store exists or not.
                          Actor user:<uuid>.
  Device <device secret>  an enrolled register (0012), plus
                          X-Register-Session: <session token> for the staff
                          member signed in on it with their PIN. The device
                          decides the store (X-Tenant-Id is optional and
                          must match). The principal is the session user's
                          membership. Revoked devices, ended/expired (12 h)
                          or idle (30 min) sessions -> 401.
                          Actor device:<uuid>/user:<uuid>.

Every scheme ends the same way: SET LOCAL ROLE tcg_pos_app, app.tenant_id,
app.user_id, app.actor and app.perms set for this transaction only; the
database stamps app.actor on every ledger/audit row (0011). Then
require(Perm.X) answers 403 {"missing": "<perm>"} unless the principal
holds it (every non-public route declares one —
tests/test_route_coverage.py).

user_session is the tenant-less variant (GET /v1/me, POST /v1/stores,
POST /v1/invites/accept): a bearer-token user, created on first sight.
device_session is the session-less register variant (the staff picker and
PIN sign-in): the device alone, actor device:<uuid>."""

import dataclasses
import hashlib
import uuid
from collections.abc import Iterator
from typing import Annotated, Any

import psycopg
from fastapi import Depends, Header, HTTPException
from psycopg.rows import dict_row

from tcg_pos_api.auth.perms import Perm
from tcg_pos_api.auth.tokens import AuthUnavailable, Claims, InvalidToken, verify_access_token
from tcg_pos_api.config import connect_kwargs, database_url

# The NOLOGIN role every request runs as (created in migrations/0001_core.sql).
# Dropping to it per transaction means RLS applies even when DATABASE_URL's
# login role owns the tables or is a superuser.
APP_ROLE = "tcg_pos_app"

NOT_A_MEMBER = "you are not a member of that store"

# Register sessions (0012): absolute lifetime and idle timeout.
SESSION_TTL_SECONDS = 12 * 3600
SESSION_IDLE_SECONDS = 30 * 60

SCHEMES = {"bearer": "Bearer", "device": "Device"}


@dataclasses.dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID | None
    tenant_id: uuid.UUID
    role_key: str | None
    perms: frozenset[str]
    # None = every location (membership.location_id NULL).
    location_ids: tuple[uuid.UUID, ...] | None
    actor: str
    # user (bearer token) | device (register device + PIN session)
    kind: str = "user"
    device_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None

    def has(self, perm: Perm | str) -> bool:
        return str(perm) in self.perms


@dataclasses.dataclass(frozen=True)
class TenantSession:
    """The request's connection (one transaction, as tcg_pos_app, scoped to
    the selected store) and the resolved caller."""

    conn: psycopg.Connection
    principal: Principal


@dataclasses.dataclass(frozen=True)
class UserSession:
    """A tenant-less request: the connection (as tcg_pos_app, no store
    selected), the verified claims and the caller's app_user row."""

    conn: psycopg.Connection
    claims: Claims
    user_id: uuid.UUID
    email: str | None
    display_name: str | None

    @property
    def actor(self) -> str:
        return f"user:{self.user_id}"


@dataclasses.dataclass(frozen=True)
class DeviceSession:
    """A register device with no staff session (staff picker, PIN sign-in):
    the connection scoped to the device's store, actor device:<uuid>."""

    conn: psycopg.Connection
    device_id: uuid.UUID
    tenant_id: uuid.UUID
    register_id: uuid.UUID

    @property
    def actor(self) -> str:
        return f"device:{self.device_id}"


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _unauthorized(detail: Any, scheme: str = "Bearer") -> HTTPException:
    return HTTPException(401, detail, headers={"WWW-Authenticate": scheme})


def _credential(authorization: str | None, allowed: tuple[str, ...]) -> tuple[str, str]:
    """(scheme, value) from the Authorization header, scheme lower-cased
    and one of `allowed`, or 401."""
    expected = " or ".join(SCHEMES[s] for s in allowed)
    if not authorization:
        raise _unauthorized("authentication required", SCHEMES[allowed[0]])
    scheme, _, value = authorization.partition(" ")
    scheme, value = scheme.lower(), value.strip()
    if scheme not in allowed or not value:
        raise _unauthorized(
            f"expected an Authorization: {expected} credential", SCHEMES[allowed[0]]
        )
    return scheme, value


def _verify_bearer(token: str) -> Claims:
    try:
        return verify_access_token(token)
    except InvalidToken as err:
        raise _unauthorized(str(err)) from None
    except AuthUnavailable:
        raise HTTPException(503, "sign-in is temporarily unavailable") from None


def bearer_claims(authorization: Annotated[str | None, Header()] = None) -> Claims:
    _, token = _credential(authorization, ("bearer",))
    return _verify_bearer(token)


def _selector(x_tenant_id: str | None) -> uuid.UUID | None:
    if not x_tenant_id:
        return None
    try:
        return uuid.UUID(x_tenant_id)
    except ValueError:
        raise HTTPException(400, "X-Tenant-Id must be a UUID") from None


def tenant_selector(x_tenant_id: Annotated[str | None, Header()] = None) -> uuid.UUID:
    selector = _selector(x_tenant_id)
    if selector is None:
        raise HTTPException(400, "X-Tenant-Id header is required (which store?)")
    return selector


def set_actor(conn: psycopg.Connection, actor: str, *, user_id: uuid.UUID | None = None) -> None:
    """Set app.actor (and app.user_id) for the rest of this transaction."""
    conn.execute(
        "SELECT set_config('app.actor', %s, true), set_config('app.user_id', %s, true)",
        (actor, str(user_id) if user_id else ""),
    )


def _set_tenant(conn: psycopg.Connection, tenant: uuid.UUID) -> None:
    conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))


def member_grants(conn: psycopg.Connection, user_id: uuid.UUID) -> dict | None:
    """The user's active membership in the transaction's store (role key,
    permissions, location scope), read as tcg_pos_app under RLS — or None."""
    return conn.execute(
        "SELECT r.key AS role_key, m.location_id, "
        "ARRAY(SELECT rp.perm FROM role_permission rp WHERE rp.role_id = r.id ORDER BY rp.perm) "
        "AS perms FROM membership m JOIN role r ON r.id = m.role_id "
        "WHERE m.user_id = %s AND m.status = 'active'",
        (user_id,),
    ).fetchone()


# --- the schemes --------------------------------------------------------------


def _bearer_principal(conn: psycopg.Connection, claims: Claims, tenant: uuid.UUID) -> Principal:
    _set_tenant(conn, tenant)
    row = conn.execute(
        "SELECT user_id, role_key, perms, location_ids FROM resolve_principal(%s, %s)",
        (claims.sub, tenant),
    ).fetchone()
    if row is None:
        raise HTTPException(403, NOT_A_MEMBER)
    return Principal(
        user_id=row["user_id"],
        tenant_id=tenant,
        role_key=row["role_key"],
        perms=frozenset(row["perms"]),
        location_ids=tuple(row["location_ids"]) if row["location_ids"] else None,
        actor=f"user:{row['user_id']}",
    )


def _device_unauthorized(reason: str) -> HTTPException:
    messages = {
        "device_unknown": "unknown or revoked register device",
        "session_required": "sign in on the register first (X-Register-Session)",
        "session_invalid": "unknown register session",
        "session_ended": "the register session was signed out",
        "session_expired": "the register session has expired",
        "session_idle": "the register session timed out",
    }
    return _unauthorized({"reason": reason, "message": messages[reason]}, "Device")


def _resolve_device(
    conn: psycopg.Connection, secret: str, session_token: str | None, selector: uuid.UUID | None
) -> dict:
    """resolve_register() for the device secret (and session token), then
    scope the transaction to the device's store. 401 for an unknown or
    revoked device; 403 if X-Tenant-Id names a different store."""
    row = conn.execute(
        "SELECT * FROM resolve_register(%s, %s, %s)",
        (
            sha256_hex(secret),
            sha256_hex(session_token) if session_token else None,
            SESSION_IDLE_SECONDS,
        ),
    ).fetchone()
    if row is None:
        raise _device_unauthorized("device_unknown")
    if selector is not None and selector != row["tenant_id"]:
        raise HTTPException(403, NOT_A_MEMBER)
    _set_tenant(conn, row["tenant_id"])
    conn.execute(
        "UPDATE register_device SET last_seen_at = now() WHERE id = %s "
        "AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')",
        (row["device_id"],),
    )
    return row


def _device_principal(
    conn: psycopg.Connection, secret: str, session_token: str | None, selector: uuid.UUID | None
) -> Principal:
    if not session_token:
        raise _device_unauthorized("session_required")
    row = _resolve_device(conn, secret, session_token.strip(), selector)
    if row["session_status"] != "ok":
        raise _device_unauthorized(f"session_{row['session_status']}")
    grants = member_grants(conn, row["user_id"])
    if grants is None:
        raise HTTPException(403, NOT_A_MEMBER)
    conn.execute(
        "UPDATE register_session SET last_seen_at = now() WHERE id = %s", (row["session_id"],)
    )
    return Principal(
        user_id=row["user_id"],
        tenant_id=row["tenant_id"],
        role_key=grants["role_key"],
        perms=frozenset(grants["perms"]),
        location_ids=(grants["location_id"],) if grants["location_id"] else None,
        actor=f"device:{row['device_id']}/user:{row['user_id']}",
        kind="device",
        device_id=row["device_id"],
        session_id=row["session_id"],
    )


def _connect() -> psycopg.Connection:
    return psycopg.connect(database_url(), row_factory=dict_row, **connect_kwargs())


def _tenant_session(
    authorization: Annotated[str | None, Header()] = None,
    x_tenant_id: Annotated[str | None, Header()] = None,
    x_register_session: Annotated[str | None, Header()] = None,
) -> Iterator[TenantSession]:
    """One connection and one transaction per request, scoped to the tenant:
    SET LOCAL ROLE drops to the RLS-bound app role and set_config(..., true)
    sets the GUCs for this transaction only, so nothing leaks to the next
    request on a pooled (Supabase transaction pooler, :6543) connection. The
    transaction commits when the route returns and rolls back if it raises
    (including HTTPException), so ledger + audit writes land together or not
    at all."""
    scheme, value = _credential(authorization, ("bearer", "device"))
    claims = None
    if scheme == "bearer":
        claims = _verify_bearer(value)  # before taking a connection
        selector = tenant_selector(x_tenant_id)
    else:
        selector = _selector(x_tenant_id)
    with _connect() as conn:
        with conn.transaction():
            conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
            if scheme == "bearer":
                principal = _bearer_principal(conn, claims, selector)
            else:
                principal = _device_principal(conn, value, x_register_session, selector)
            set_actor(conn, principal.actor, user_id=principal.user_id)
            conn.execute(
                "SELECT set_config('app.perms', %s, true)", (",".join(sorted(principal.perms)),)
            )
            yield TenantSession(conn=conn, principal=principal)


def _user_session(claims: Annotated[Claims, Depends(bearer_claims)]) -> Iterator[UserSession]:
    with _connect() as conn:
        with conn.transaction():
            conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
            user = conn.execute(
                "SELECT id, email, display_name FROM ensure_app_user(%s, %s)",
                (claims.sub, claims.email),
            ).fetchone()
            session = UserSession(
                conn=conn,
                claims=claims,
                user_id=user["id"],
                email=user["email"],
                display_name=user["display_name"],
            )
            set_actor(conn, session.actor, user_id=session.user_id)
            yield session


def _device_session(
    authorization: Annotated[str | None, Header()] = None,
    x_tenant_id: Annotated[str | None, Header()] = None,
) -> Iterator[DeviceSession]:
    _, secret = _credential(authorization, ("device",))
    selector = _selector(x_tenant_id)
    with _connect() as conn:
        with conn.transaction():
            conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
            row = _resolve_device(conn, secret, None, selector)
            session = DeviceSession(
                conn=conn,
                device_id=row["device_id"],
                tenant_id=row["tenant_id"],
                register_id=row["register_id"],
            )
            set_actor(conn, session.actor)
            yield session


# scope="function": commit before the response is sent, so a failed commit
# surfaces as a 500 instead of a 2xx for a write that never landed. Every
# Depends on these must use the same scope so FastAPI's per-request cache
# hands require() and the route the same session.
Session = Annotated[TenantSession, Depends(_tenant_session, scope="function")]
UserConn = Annotated[UserSession, Depends(_user_session, scope="function")]
DeviceConn = Annotated[DeviceSession, Depends(_device_session, scope="function")]


def require(perm: Perm):
    """Dependency: the request's TenantSession, or 403 {"missing": perm}.
    Use as a route parameter (`session: Annotated[TenantSession,
    require(Perm.X)]`) or in the decorator's dependencies=[...]."""
    perm = Perm(perm)

    def check(session: Session) -> TenantSession:
        if not session.principal.has(perm):
            raise HTTPException(403, {"missing": perm.value})
        return session

    check.required_perm = perm  # read by tests/test_route_coverage.py
    check.__name__ = f"require_{perm.name.lower()}"
    return Depends(check)


def member_session(session: Session) -> TenantSession:
    """Any active member of the store, signed in with their own bearer token
    (not a register session): routes about the caller themselves, e.g.
    PUT /v1/me/pin. Listed in tests/test_route_coverage.py."""
    if session.principal.kind != "user":
        raise HTTPException(403, {"reason": "sign_in_required"})
    return session


def register_session(session: Session) -> TenantSession:
    """A staff member signed in on a register (Device + X-Register-Session):
    sign-out and approvals. Listed in tests/test_route_coverage.py."""
    if session.principal.kind != "device":
        raise HTTPException(403, {"reason": "register_session_required"})
    return session


MemberSession = Annotated[TenantSession, Depends(member_session)]
RegisterSession = Annotated[TenantSession, Depends(register_session)]
