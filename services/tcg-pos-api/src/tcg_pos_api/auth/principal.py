"""Who is calling, resolved per request inside the request's one transaction.

  1. bearer_claims: verify `Authorization: Bearer <access token>` -> sub
     (401 otherwise; 503 if the issuer's keys can't be fetched).
  2. tenant_selector: X-Tenant-Id says WHICH of the caller's stores this
     request is for. It is only a selector, never trusted on its own.
  3. tenant_session: SET LOCAL ROLE tcg_pos_app, app.tenant_id = selector,
     then resolve_principal(sub, tenant) — the caller's active membership,
     role and permissions, read from Postgres. No row -> 403, the same
     response whether the store exists or not. Then app.user_id, app.actor
     ("user:<uuid>") and app.perms are set for the transaction; the
     database stamps app.actor on every ledger/audit row (0011).
  4. require(Perm.X): 403 {"missing": "<perm>"} unless the principal holds
     it. Every non-public route declares one (tests/test_route_coverage.py).

user_session is the tenant-less variant (GET /v1/me, POST /v1/stores,
POST /v1/invites/accept): the verified user, created on first sight."""

import dataclasses
import uuid
from collections.abc import Iterator
from typing import Annotated

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


@dataclasses.dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    role_key: str
    perms: frozenset[str]
    # None = every location (membership.location_id NULL).
    location_ids: tuple[uuid.UUID, ...] | None
    actor: str

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


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(401, detail, headers={"WWW-Authenticate": "Bearer"})


def bearer_claims(authorization: Annotated[str | None, Header()] = None) -> Claims:
    if not authorization:
        raise _unauthorized("authentication required")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _unauthorized("expected an Authorization: Bearer token")
    try:
        return verify_access_token(token.strip())
    except InvalidToken as err:
        raise _unauthorized(str(err)) from None
    except AuthUnavailable:
        raise HTTPException(503, "sign-in is temporarily unavailable") from None


def tenant_selector(x_tenant_id: Annotated[str | None, Header()] = None) -> uuid.UUID:
    if not x_tenant_id:
        raise HTTPException(400, "X-Tenant-Id header is required (which store?)")
    try:
        return uuid.UUID(x_tenant_id)
    except ValueError:
        raise HTTPException(400, "X-Tenant-Id must be a UUID") from None


def set_actor(conn: psycopg.Connection, actor: str, *, user_id: uuid.UUID | None = None) -> None:
    """Set app.actor (and app.user_id) for the rest of this transaction."""
    conn.execute(
        "SELECT set_config('app.actor', %s, true), set_config('app.user_id', %s, true)",
        (actor, str(user_id) if user_id else ""),
    )


def _tenant_session(
    claims: Annotated[Claims, Depends(bearer_claims)],
    tenant: Annotated[uuid.UUID, Depends(tenant_selector)],
) -> Iterator[TenantSession]:
    """One connection and one transaction per request, scoped to the tenant:
    SET LOCAL ROLE drops to the RLS-bound app role and set_config(..., true)
    sets the GUCs for this transaction only, so nothing leaks to the next
    request on a pooled (Supabase transaction pooler, :6543) connection. The
    transaction commits when the route returns and rolls back if it raises
    (including HTTPException), so ledger + audit writes land together or not
    at all."""
    with psycopg.connect(database_url(), row_factory=dict_row, **connect_kwargs()) as conn:
        with conn.transaction():
            conn.execute(f"SET LOCAL ROLE {APP_ROLE}")
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))
            row = conn.execute(
                "SELECT user_id, role_key, perms, location_ids FROM resolve_principal(%s, %s)",
                (claims.sub, tenant),
            ).fetchone()
            if row is None:
                raise HTTPException(403, NOT_A_MEMBER)
            principal = Principal(
                user_id=row["user_id"],
                tenant_id=tenant,
                role_key=row["role_key"],
                perms=frozenset(row["perms"]),
                location_ids=tuple(row["location_ids"]) if row["location_ids"] else None,
                actor=f"user:{row['user_id']}",
            )
            set_actor(conn, principal.actor, user_id=principal.user_id)
            conn.execute(
                "SELECT set_config('app.perms', %s, true)", (",".join(sorted(principal.perms)),)
            )
            yield TenantSession(conn=conn, principal=principal)


def _user_session(claims: Annotated[Claims, Depends(bearer_claims)]) -> Iterator[UserSession]:
    with psycopg.connect(database_url(), row_factory=dict_row, **connect_kwargs()) as conn:
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


# scope="function": commit before the response is sent, so a failed commit
# surfaces as a 500 instead of a 2xx for a write that never landed. Every
# Depends on these must use the same scope so FastAPI's per-request cache
# hands require() and the route the same session.
Session = Annotated[TenantSession, Depends(_tenant_session, scope="function")]
UserConn = Annotated[UserSession, Depends(_user_session, scope="function")]


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
