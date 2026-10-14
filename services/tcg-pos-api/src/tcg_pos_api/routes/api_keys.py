"""Store API keys (apikeys.manage; owners by default):

  POST   /v1/api-keys          {name, perms[]} -> the key, shown once
  GET    /v1/api-keys          all keys, newest first (never the secret)
  DELETE /v1/api-keys/{id}     revoke (instant)

A key's perms must be a subset of the creator's permissions at creation and
may not include the identity/admin permissions in FORBIDDEN (managing staff,
roles, registers or keys, approving, billing): a key is for integrations,
not for administering people. Requests use `Authorization: ApiKey
tcgpos_<prefix>_<secret>` and act as apikey:<id> (auth/principal.py)."""

import secrets
import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException

from tcg_pos_api import queries
from tcg_pos_api.auth import Perm, TenantSession, require
from tcg_pos_api.auth.principal import sha256_hex
from tcg_pos_api.routes.models import ApiKey, ApiKeyCreate, ApiKeyCreated

router = APIRouter(prefix="/api-keys", tags=["api keys"])

KeysSession = Annotated[TenantSession, require(Perm.APIKEYS_MANAGE)]

FORBIDDEN = frozenset(
    {
        Perm.STAFF_MANAGE,
        Perm.ROLES_MANAGE,
        Perm.REGISTERS_MANAGE,
        Perm.APIKEYS_MANAGE,
        Perm.APPROVE_OVERRIDE,
        Perm.BILLING_MANAGE,
    }
)

KEY_SQL = (
    "SELECT id, name, prefix, perms, created_by, created_at, last_used_at, revoked_at, "
    "CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status FROM api_key"
)


@router.post("", response_model=ApiKeyCreated, status_code=201)
def create_api_key(session: KeysSession, body: ApiKeyCreate) -> ApiKeyCreated:
    conn, principal = session.conn, session.principal
    perms = set()
    for p in body.perms:
        try:
            perms.add(Perm(p))
        except ValueError:
            raise HTTPException(422, f"unknown permission {p!r}") from None
    forbidden = sorted(p.value for p in perms & FORBIDDEN)
    if forbidden:
        raise HTTPException(
            422, {"reason": "API keys can't hold these permissions", "perms": forbidden}
        )
    missing = sorted(p.value for p in perms if not principal.has(p))
    if missing:
        raise HTTPException(
            403, {"reason": "you can't give a key permissions you don't have", "missing": missing}
        )
    prefix = secrets.token_hex(6)
    secret = secrets.token_urlsafe(32)
    key_id = conn.execute(
        "INSERT INTO api_key (name, prefix, secret_hash, perms) VALUES (%s, %s, %s, %s) "
        "RETURNING id",
        (body.name, prefix, sha256_hex(secret), sorted(p.value for p in perms)),
    ).fetchone()["id"]
    queries.write_audit(
        conn,
        action="apikey.create",
        entity="api_key",
        entity_id=key_id,
        before=None,
        after={"name": body.name, "prefix": prefix, "perms": sorted(p.value for p in perms)},
    )
    row = conn.execute(f"{KEY_SQL} WHERE id = %s", (key_id,)).fetchone()
    return ApiKeyCreated(**row, key=f"tcgpos_{prefix}_{secret}")


@router.get("", response_model=list[ApiKey])
def list_api_keys(session: KeysSession) -> list[ApiKey]:
    rows = session.conn.execute(f"{KEY_SQL} ORDER BY created_at DESC, id LIMIT 500").fetchall()
    return [ApiKey(**r) for r in rows]


@router.delete("/{key_id}", response_model=ApiKey)
def revoke_api_key(session: KeysSession, key_id: uuid.UUID) -> ApiKey:
    conn = session.conn
    row = conn.execute(f"{KEY_SQL} WHERE id = %s FOR UPDATE", (key_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "no API key with that id")
    if row["status"] == "revoked":
        raise HTTPException(409, "that key is already revoked")
    conn.execute("UPDATE api_key SET revoked_at = now() WHERE id = %s", (key_id,))
    queries.write_audit(
        conn,
        action="apikey.revoke",
        entity="api_key",
        entity_id=key_id,
        before={"status": "active"},
        after={"status": "revoked"},
    )
    return ApiKey(**conn.execute(f"{KEY_SQL} WHERE id = %s", (key_id,)).fetchone())
