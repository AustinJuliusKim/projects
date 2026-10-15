"""The signed-in user, independent of any store (no X-Tenant-Id):

  GET  /v1/me           who am I, and which stores can I open (store switcher).
  POST /v1/me/identity  {id_token}: set my email + name from my verified ID
                        token (Cognito access tokens carry no email).
  POST /v1/stores       onboarding: a new store + first location, caller as
                        owner. Capped per user (MAX_OWNED_STORES, default 5)
                        and rate-limited (STORE_CREATE_LIMIT per hour,
                        default 3).

All run as the verified bearer user (auth.UserConn), who is created on
first sight from the token's `sub` (plus the token's `email` only for the
local dev issuer's tokens; everyone else's email comes from their verified
ID token through /v1/me/identity)."""

import os

from fastapi import APIRouter, HTTPException

from tcg_pos_api import ratelimit
from tcg_pos_api.auth import UserConn
from tcg_pos_api.auth.tokens import AuthUnavailable, InvalidToken, verify_id_token
from tcg_pos_api.routes.models import IdentitySync, Me, MeUser, MyStore, StoreCreate

router = APIRouter(tags=["account"])

STORE_WINDOW_SECONDS = 3600


def _stores(session) -> list[MyStore]:
    rows = session.conn.execute(
        "SELECT tenant_id, name, role_key, role_name FROM my_stores(%s)", (session.claims.sub,)
    ).fetchall()
    return [
        MyStore(
            tenant_id=r["tenant_id"], name=r["name"], role=r["role_key"], role_name=r["role_name"]
        )
        for r in rows
    ]


@router.get("/me", response_model=Me)
def me(session: UserConn) -> Me:
    return Me(
        user=MeUser(id=session.user_id, email=session.email, display_name=session.display_name),
        stores=_stores(session),
    )


@router.post("/me/identity", response_model=Me)
def sync_identity(session: UserConn, body: IdentitySync) -> Me:
    """Store the email (must be verified) and name from the caller's ID
    token. The ID token must be for the same user (`sub`) as the bearer
    access token and for one of our app clients. 422 {"reason": ...} if
    not."""
    try:
        identity = verify_id_token(body.id_token.strip(), expected_sub=session.claims.sub)
    except InvalidToken as err:
        raise HTTPException(422, {"reason": "invalid_id_token", "message": str(err)}) from None
    except AuthUnavailable:
        raise HTTPException(503, "sign-in is temporarily unavailable") from None
    user = session.conn.execute(
        "SELECT id, email, display_name FROM set_user_identity(%s, %s, %s)",
        (session.claims.sub, identity.email, identity.display_name),
    ).fetchone()
    return Me(user=MeUser(**user), stores=_stores(session))


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@router.post("/stores", response_model=MyStore, status_code=201)
def create_store(session: UserConn, body: StoreCreate) -> MyStore:
    """Create a store with one location and make the caller its owner, in
    one transaction (create_store() in 0011)."""
    conn = session.conn
    # One store creation per user at a time, so the cap can't be raced.
    conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"stores:{session.user_id}",)
    )
    owned = sum(1 for s in _stores(session) if s.role == "owner")
    cap = _env_int("MAX_OWNED_STORES", 5)
    if owned >= cap:
        raise HTTPException(403, {"reason": "store_limit", "limit": cap})
    ratelimit.enforce(
        f"stores:user:{session.user_id}",
        _env_int("STORE_CREATE_LIMIT", 3),
        STORE_WINDOW_SECONDS,
    )
    tenant_id = conn.execute(
        "SELECT create_store(%s, %s, %s, %s) AS id",
        (session.claims.sub, session.email, body.name, body.location_name),
    ).fetchone()["id"]
    store = next((s for s in _stores(session) if s.tenant_id == tenant_id), None)
    if store is None:  # pragma: no cover — create_store makes the caller owner
        raise HTTPException(500, "store was created without an owner")
    return store
