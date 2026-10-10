"""Public storefront API, /v1/storefront/{slug}. No auth: the tenant comes
from the slug (deps.StorefrontConn), never from a header. Search and
autocomplete (OpenSearch) are added in M6; card detail will call
storefront.storefront_offers for its live offers, like /offers here.

Reservations are for in-store pickup; no payment is taken. Public writes
are rate limited per IP (ratelimit.py) and capped at 40 lines × 20 copies."""

import hmac
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.encoders import jsonable_encoder

from tcg_pos_api import storefront
from tcg_pos_api.deps import StorefrontConn, StorefrontSession
from tcg_pos_api.ratelimit import order_limit, quote_limit
from tcg_pos_api.routes.models import (
    CartQuote,
    CartQuoteIn,
    PickupLocation,
    StorefrontInfo,
    StorefrontOffer,
    StorefrontOffers,
    WebOrderIn,
    WebOrderLine,
    WebOrderPublic,
)

router = APIRouter(prefix="/storefront/{slug}", tags=["storefront (public)"])

OFFERS_QUERY_MAX = 100


def store_info(session: StorefrontSession) -> StorefrontInfo:
    store = session.store
    loc = session.conn.execute(
        "SELECT id, name FROM location WHERE id = %s", (store.location_id,)
    ).fetchone()
    return StorefrontInfo(
        slug=store.slug,
        display_name=store.display_name,
        pickup_location=PickupLocation(**loc),
        pickup_text=store.pickup_text,
        policy_text=store.policy_text,
        reservation_hours=store.reservation_hours,
    )


@router.get("", response_model=StorefrontInfo)
def get_store(session: StorefrontConn) -> StorefrontInfo:
    """Store name, pickup location and policies."""
    return store_info(session)


@router.get("/offers", response_model=StorefrontOffers)
def get_offers(
    session: StorefrontConn,
    printing_id: Annotated[list[uuid.UUID], Query(min_length=1, max_length=OFFERS_QUERY_MAX)],
) -> StorefrontOffers:
    """Live offers (priced, web-available after holdback) for up to 100
    printings, read from Postgres — the source of truth, not the index."""
    by_printing = storefront.storefront_offers(session.conn, session.store, printing_id)
    return StorefrontOffers(
        offers=[StorefrontOffer(**o) for offers in by_printing.values() for o in offers]
    )


@router.post("/cart/quote", response_model=CartQuote)
def quote(
    _: Annotated[None, Depends(quote_limit)], session: StorefrontConn, body: CartQuoteIn
) -> CartQuote:
    """Re-price a cart against live stock without reserving anything. Each
    line reports ok / not_found / not_priced / insufficient / price_changed."""
    results, _items = storefront.check_lines(
        session.conn, session.store, [line.model_dump() for line in body.lines], lock=False
    )
    return CartQuote(
        ok=all(r["status"] == "ok" for r in results),
        total_cents=sum(r["line_total_cents"] or 0 for r in results if r["status"] == "ok"),
        lines=results,
    )


def _public_order(session: StorefrontSession, order: dict, lines: list[dict]) -> WebOrderPublic:
    return WebOrderPublic(
        **{k: order[k] for k in (
            "id", "status", "pickup_code", "customer_name", "total_cents", "expires_at",
            "created_at",
        )},
        store=store_info(session),
        lines=[WebOrderLine(**line) for line in lines],
    )


@router.post("/orders", response_model=WebOrderPublic, status_code=201)
def create_order(
    _: Annotated[None, Depends(order_limit)],
    session: StorefrontConn,
    body: WebOrderIn,
    response: Response,
) -> WebOrderPublic:
    """Reserve the cart for pickup, all lines or none. 201 with the order
    (pickup code, expiry); 200 with the original order when the
    idempotency_key was already used for the same cart; 409 with detail
    {message, issues} — per-line `issues` (quote line results) when any line
    can't be reserved as asked, or empty issues when the key was used for a
    different cart."""
    try:
        order, lines, created = storefront.reserve_order(
            session.conn,
            session.store,
            idempotency_key=body.idempotency_key,
            customer=body.customer.model_dump(),
            lines=[line.model_dump() for line in body.lines],
        )
    except storefront.OrderRejected as err:
        raise HTTPException(
            409,
            {"message": "some lines can't be reserved", "issues": jsonable_encoder(err.issues)},
        ) from None
    except storefront.IdempotencyConflict:
        raise HTTPException(
            409,
            {"message": "idempotency_key was already used for a different order", "issues": []},
        ) from None
    if not created:
        response.status_code = 200
    return _public_order(session, order, lines)


@router.get("/orders/{order_id}", response_model=WebOrderPublic)
def get_order(
    session: StorefrontConn,
    order_id: uuid.UUID,
    code: Annotated[str, Query(min_length=1, max_length=20)],
) -> WebOrderPublic:
    """The customer's confirmation page. Needs the order's pickup code; a
    wrong code is the same 404 as a missing order."""
    order = storefront.get_order(session.conn, order_id)
    given = code.strip().upper().encode()
    if order is None or not hmac.compare_digest(order["pickup_code"].encode(), given):
        raise HTTPException(404, "no such order")
    lines = storefront.order_lines(session.conn, [order_id])[order_id]
    return _public_order(session, order, lines)
