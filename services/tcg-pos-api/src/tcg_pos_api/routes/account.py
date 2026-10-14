"""The signed-in user, independent of any store (no X-Tenant-Id):

  GET  /v1/me      who am I, and which stores can I open (store switcher).
  POST /v1/stores  onboarding: a new store + first location, caller as owner.

Both run as the verified user (auth.UserConn), who is created on first
sight from the token's `sub` (and `email`, when the token carries one)."""

from fastapi import APIRouter, HTTPException

from tcg_pos_api.auth import UserConn
from tcg_pos_api.routes.models import Me, MeUser, MyStore, StoreCreate

router = APIRouter(tags=["account"])


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


@router.post("/stores", response_model=MyStore, status_code=201)
def create_store(session: UserConn, body: StoreCreate) -> MyStore:
    """Create a store with one location and make the caller its owner, in
    one transaction (create_store() in 0011)."""
    tenant_id = session.conn.execute(
        "SELECT create_store(%s, %s, %s, %s) AS id",
        (session.claims.sub, session.claims.email, body.name, body.location_name),
    ).fetchone()["id"]
    store = next((s for s in _stores(session) if s.tenant_id == tenant_id), None)
    if store is None:  # pragma: no cover — create_store makes the caller owner
        raise HTTPException(500, "store was created without an owner")
    return store
