"""Staff side of web orders, /v1/web-orders: list reservations, mark them
picked up, or cancel them (which puts the stock back). The public side is
routes/storefront.py; the shared logic is in tcg_pos_api/storefront.py."""

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from tcg_pos_api import storefront
from tcg_pos_api.deps import Perm, TenantConn, require
from tcg_pos_api.routes.models import (
    WebOrderLine,
    WebOrderPage,
    WebOrderStaff,
    WebOrderStatus,
)

router = APIRouter(prefix="/web-orders", tags=["storefront"])

PAGE_MAX = 100_000


def _staff(order: dict, lines: list[dict]) -> WebOrderStaff:
    return WebOrderStaff(**order, lines=[WebOrderLine(**line) for line in lines])


def _one(conn, order: dict) -> WebOrderStaff:
    return _staff(order, storefront.order_lines(conn, [order["id"]])[order["id"]])


@router.get("", response_model=WebOrderPage, dependencies=[require(Perm.WEB_ORDERS_READ)])
def list_orders(
    conn: TenantConn,
    status: WebOrderStatus | None = None,
    page: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
) -> WebOrderPage:
    """Newest first, optionally filtered by status, with lines."""
    total, orders = storefront.list_orders(conn, status=status, page=page, page_size=page_size)
    lines = storefront.order_lines(conn, [o["id"] for o in orders])
    return WebOrderPage(
        total=total, page=page, page_size=page_size,
        orders=[_staff(o, lines[o["id"]]) for o in orders],
    )


@router.post(
    "/{order_id}/picked-up",
    response_model=WebOrderStaff,
    dependencies=[require(Perm.WEB_ORDERS_FULFILL)],
)
def picked_up(conn: TenantConn, order_id: uuid.UUID) -> WebOrderStaff:
    """reserved -> picked_up. 409 if the order is no longer reserved."""
    try:
        order = storefront.mark_picked_up(conn, order_id)
    except storefront.OrderStateError as err:
        raise HTTPException(409, f"order is {err.status}, not reserved") from None
    if order is None:
        raise HTTPException(404, "no web order with that id")
    return _one(conn, order)


@router.post(
    "/{order_id}/cancel",
    response_model=WebOrderStaff,
    dependencies=[require(Perm.WEB_ORDERS_FULFILL)],
)
def cancel(conn: TenantConn, order_id: uuid.UUID) -> WebOrderStaff:
    """reserved -> cancelled, restoring each line's qty with a +n ledger row
    (channel 'web', reason 'web_cancel:<id>'). 409 if the order is no
    longer reserved, so stock is restored exactly once."""
    try:
        order = storefront.release_order(conn, order_id, status="cancelled")
    except storefront.OrderStateError as err:
        raise HTTPException(409, f"order is {err.status}, not reserved") from None
    if order is None:
        raise HTTPException(404, "no web order with that id")
    return _one(conn, order)
