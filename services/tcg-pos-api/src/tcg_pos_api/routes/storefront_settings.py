"""GET/PUT /v1/storefront-settings — the staff side of the tenant's web
storefront (slug, published flag, web/pickup location, holdback, reservation
window). The public side is routes/storefront.py."""

import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from tcg_pos_api import queries
from tcg_pos_api.deps import Actor, TenantConn, tenant_id
from tcg_pos_api.routes.models import StorefrontSettings, StorefrontSettingsOut

router = APIRouter(prefix="/storefront-settings", tags=["storefront"])


def _fields(row: dict) -> dict:
    return {k: row[k] for k in queries.STOREFRONT_FIELDS}


@router.get("", response_model=StorefrontSettingsOut)
def get_settings(conn: TenantConn) -> StorefrontSettingsOut:
    row = queries.get_storefront(conn)
    if row is None:
        raise HTTPException(404, "this store has no storefront yet")
    return StorefrontSettingsOut(**row)


@router.put("", response_model=StorefrontSettingsOut)
def put_settings(
    actor: Actor,
    conn: TenantConn,
    tenant: Annotated[uuid.UUID, Depends(tenant_id)],
    body: StorefrontSettings,
) -> StorefrontSettingsOut:
    """Create or replace the storefront. Audit-logged with before (null on
    create) and after. A slug or custom domain another store already uses is
    a 409; a location that isn't this store's is a 404."""
    before = queries.get_storefront(conn, lock=True)
    try:
        after = queries.upsert_storefront(conn, body.model_dump())
    except psycopg.errors.UniqueViolation as err:
        what = "custom domain" if "custom_domain" in str(err) else "slug"
        raise HTTPException(409, f"that {what} is already taken") from None
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(404, "no location with that id") from None
    queries.write_audit(
        conn,
        actor=actor,
        action="storefront.update",
        entity="storefront",
        entity_id=tenant,
        before=_fields(before) if before else None,
        after=_fields(after),
    )
    return StorefrontSettingsOut(**after)
