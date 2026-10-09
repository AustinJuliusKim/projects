import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, HTTPException, Query

from tcg_pos_api import queries
from tcg_pos_api.deps import Actor, TenantConn
from tcg_pos_api.routes.models import (
    InventoryAdjust,
    InventoryAdjustResult,
    InventoryItem,
    InventoryPage,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])


@router.get("", response_model=InventoryPage)
def list_inventory(
    conn: TenantConn,
    location_id: uuid.UUID | None = None,
    printing_id: uuid.UUID | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
) -> InventoryPage:
    total, rows = queries.list_inventory(
        conn, location_id=location_id, printing_id=printing_id, page=page, page_size=page_size
    )
    return InventoryPage(
        total=total, page=page, page_size=page_size, items=[InventoryItem(**r) for r in rows]
    )


# `actor` is declared before `conn` so a missing X-Actor 401s before a DB
# connection is opened (FastAPI resolves dependencies in declaration order).
@router.post("/adjust", response_model=InventoryAdjustResult)
def adjust(actor: Actor, conn: TenantConn, body: InventoryAdjust) -> InventoryAdjustResult:
    """Apply a signed quantity change at the item's grain. The item update,
    its inventory_ledger row and its audit_log row commit together or not at
    all; a change that would take qty below 0 is rejected with 409."""
    grain = body.model_dump(
        include={"location_id", "printing_id", "game", "condition", "finish", "lang"}
    )
    try:
        before, created = queries.lock_or_create_item(conn, grain)
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(404, "no location with that id") from None

    new_qty = before["qty"] + body.delta
    if new_qty < 0:
        raise HTTPException(
            409, f"adjustment would make qty negative (on hand {before['qty']}, delta {body.delta})"
        )
    after = queries.set_item_qty(conn, before["id"], new_qty)
    ledger_id = queries.insert_inventory_ledger(
        conn,
        item_id=after["id"],
        delta=body.delta,
        reason=body.reason,
        channel=body.channel,
        actor=actor,
    )
    queries.write_audit(
        conn,
        actor=actor,
        action="inventory.adjust",
        entity="inventory_item",
        entity_id=after["id"],
        before=None if created else before,
        after=after,
    )
    return InventoryAdjustResult(item=InventoryItem(**after), ledger_id=ledger_id)
