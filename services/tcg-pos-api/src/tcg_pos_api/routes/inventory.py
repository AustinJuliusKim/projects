import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, HTTPException, Query

from tcg_pos_api import queries
from tcg_pos_api.deps import Actor, TenantConn
from tcg_pos_api.routes.models import (
    INT32_MAX,
    InventoryAdjust,
    InventoryAdjustResult,
    InventoryItem,
    InventoryPage,
    InventoryPriceUpdate,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])

PAGE_MAX = 100_000


@router.get("", response_model=InventoryPage)
def list_inventory(
    conn: TenantConn,
    location_id: uuid.UUID | None = None,
    printing_id: uuid.UUID | None = None,
    # Capped so OFFSET ((page - 1) * page_size) stays far inside bigint.
    page: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 1,
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
    if new_qty > INT32_MAX:
        raise HTTPException(
            409, f"adjustment would overflow qty (on hand {before['qty']}, delta {body.delta})"
        )
    after = queries.set_item_qty(conn, before["id"], new_qty)
    if body.price_cents is not None and body.price_cents != after["price_cents"]:
        after = queries.set_item_price(conn, after["id"], body.price_cents)
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


@router.patch("/{item_id}", response_model=InventoryItem)
def set_price(
    actor: Actor, conn: TenantConn, item_id: uuid.UUID, body: InventoryPriceUpdate
) -> InventoryItem:
    """Set or clear (null) an item's shelf price. Quantity is untouched and no
    ledger row is written — the ledger is quantity only; the price change is
    an audit_log row in the same transaction."""
    before = queries.lock_item(conn, item_id)
    if before is None:
        raise HTTPException(404, "no inventory item with that id")
    if before["price_cents"] == body.price_cents:
        return InventoryItem(**before)
    after = queries.set_item_price(conn, item_id, body.price_cents)
    queries.write_audit(
        conn,
        actor=actor,
        action="inventory.price",
        entity="inventory_item",
        entity_id=item_id,
        before=before,
        after=after,
    )
    return InventoryItem(**after)
