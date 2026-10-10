"""Public storefront API, /v1/storefront/{slug}. No auth: the tenant comes
from the slug (deps.StorefrontConn), never from a header.

Search (OpenSearch, via services/tcg-search):
  GET /search        tcg_search.query.search() output verbatim, always for
                     this store: mode=stock searches the store's listings
                     (tenant filter + routing), mode=catalog the whole
                     catalog with each result annotated in_stock /
                     store_price_cents from this store's listings.
  GET /autocomplete  tcg_search.query.autocomplete() output verbatim
                     (in-stock names first, catalog fill).
  GET /cards/{id}    card data from the catalog index (mtg-api if
                     OpenSearch is down) + LIVE offers from Postgres.
OpenSearch down -> 503 "search is temporarily unavailable".

Reservations are for in-store pickup; no payment is taken. Public writes
are rate limited per IP (ratelimit.py) and capped at 40 lines × 20 copies."""

import contextlib
import hmac
import uuid
from collections.abc import Iterator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.encoders import jsonable_encoder
from tcg_search.client import OpenSearch, OpenSearchError, OpenSearchUnavailable
from tcg_search.docs import card_fields
from tcg_search.query import SearchRequest, autocomplete, search
from tcg_search.query.shape import shape_hit

from tcg_pos_api import storefront
from tcg_pos_api.catalog import Catalog, get_catalog
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
from tcg_pos_api.search import catalog_alias, get_search, listings_alias

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


# --- search ---------------------------------------------------------------------------

Search = Annotated[OpenSearch, Depends(get_search)]
# Facet params: tcg_search's facet names (query.build.facet_names("listings")).
# Repeat a param for several values (?set=mh2&set=ltr): OR within a facet,
# AND across facets.
FacetParam = Annotated[list[str] | None, Query(max_length=50)]
UNAVAILABLE = "search is temporarily unavailable"


@contextlib.contextmanager
def search_errors() -> Iterator[None]:
    try:
        yield
    except OpenSearchUnavailable:
        raise HTTPException(503, UNAVAILABLE) from None
    except OpenSearchError as err:
        if err.status == 404:  # alias/index not built yet
            raise HTTPException(503, "search index is not built yet") from None
        raise HTTPException(502, f"search failed ({err.status})") from None


def annotate_in_stock(os_: OpenSearch, tenant_id: str, results: list[dict[str, Any]]) -> None:
    """Catalog-mode results: set in_stock (copies this store sells online, 0
    if none) and store_price_cents (its cheapest offer, or null) from the
    store's listings, by one routed, tenant-filtered terms lookup."""
    ids = [r["oracle_id"] for r in results if r.get("oracle_id")]
    found: dict[str, dict[str, Any]] = {}
    if ids:
        raw = os_.search(listings_alias(), {
            "size": len(ids),
            "_source": ["oracle_id", "in_stock", "price_cents"],
            "query": {"bool": {"filter": [
                {"term": {"tenant_id": tenant_id}},
                {"terms": {"oracle_id": ids}},
            ]}},
        }, params={"routing": tenant_id})
        found = {h["_source"]["oracle_id"]: h["_source"]
                 for h in raw.get("hits", {}).get("hits", [])}
    for r in results:
        hit = found.get(r.get("oracle_id"))
        r["in_stock"] = (hit or {}).get("in_stock", 0)
        r["store_price_cents"] = (hit or {}).get("price_cents")


@router.get("/search")
def search_store(
    session: StorefrontConn,
    os_: Search,
    q: Annotated[str, Query(max_length=500)] = "",
    mode: Literal["stock", "catalog"] = "stock",
    sort: Annotated[str, Query(max_length=20)] = "relevance",
    page: Annotated[int, Query(ge=1, le=2400)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 24,
    set_: Annotated[list[str] | None, Query(alias="set", max_length=50)] = None,
    rarity: FacetParam = None,
    finish: FacetParam = None,
    condition: FacetParam = None,
    price: FacetParam = None,
    colors: FacetParam = None,
    identity: FacetParam = None,
    types: FacetParam = None,
    keywords: FacetParam = None,
    format_: Annotated[list[str] | None, Query(alias="format", max_length=50)] = None,
) -> dict[str, Any]:
    """Search this store. `q` takes free text and Scryfall-style syntax
    (`t:dragon c:r mv<=4`). Sorts: relevance, popular, name, price_asc,
    price_desc, newest, mv (unknown -> relevance + a warning). Facets:
    set, rarity, finish, condition (stock only), price (band keys 0-100,
    100-500, 500-2000, 2000-5000, 5000-10000, 10000-), colors, identity,
    types, keywords, format. The response is tcg_search's search shape:
    {mode, q, total, took_ms, page, page_size, sort, results[], facets{},
    query{clauses[]}, warnings[], did_you_mean, corrected}."""
    tenant = str(session.store.tenant_id)
    raw_facets = {"set": set_, "rarity": rarity, "finish": finish, "condition": condition,
                  "price": price, "colors": colors, "identity": identity, "types": types,
                  "keywords": keywords, "format": format_}
    facets = {k: [x for x in v if x.strip()] for k, v in raw_facets.items() if v}
    req = SearchRequest(q=q, mode=mode, tenant_id=tenant, facets=facets, sort=sort, page=page,
                        page_size=page_size)
    with search_errors():
        out = search(os_, req, catalog_index=catalog_alias(), listings_index=listings_alias())
        if mode == "catalog":
            annotate_in_stock(os_, tenant, out["results"])
    return out


@router.get("/autocomplete")
def autocomplete_store(
    session: StorefrontConn,
    os_: Search,
    q: Annotated[str, Query(max_length=100)] = "",
    size: Annotated[int, Query(ge=1, le=20)] = 8,
) -> list[dict[str, Any]]:
    """Name suggestions: this store's in-stock cards first (in_stock true),
    then catalog matches (in_stock false) up to `size`. Each is {oracle_id,
    name, image_small?, price_cents?, type_line?, in_stock}."""
    with search_errors():
        return autocomplete(os_, q, tenant_id=str(session.store.tenant_id), size=size,
                            catalog_index=catalog_alias(), listings_index=listings_alias())


def _printing_out(p: dict[str, Any], *, from_index: bool) -> dict[str, Any]:
    """A card-page printing, from a catalog-index printing or mtg-api's."""
    if from_index:
        pid, set_code = p.get("printing_id"), p.get("set")
    else:
        pid, set_code = p.get("id"), p.get("set_code")
    return {
        "id": str(pid),
        "set_code": set_code,
        "set_name": p.get("set_name"),
        "collector_number": p.get("collector_number"),
        "rarity": p.get("rarity"),
        "finishes": p.get("finishes") or [],
        "released_at": str(p["released_at"]) if p.get("released_at") else None,
        "lang": p.get("lang"),
        "image_small": p.get("image_small"),
        "image_normal": p.get("image_normal"),
    }


def _card_out(src: dict[str, Any], printings: list[dict[str, Any]]) -> dict[str, Any]:
    card = shape_hit({"_source": src}, "catalog")
    card.pop("score", None)
    card["printings"] = printings
    return card


def card_from_index(os_: OpenSearch, oracle_id: str) -> dict[str, Any] | None:
    src = os_.mget(catalog_alias(), [oracle_id])[0]
    if src is None:
        return None
    return _card_out(src, [_printing_out(p, from_index=True) for p in src.get("printings") or []])


def card_from_mtg_api(catalog: Catalog, oracle_id: str) -> dict[str, Any] | None:
    row = catalog.card(oracle_id)
    if row is None:
        return None
    paper = [p for p in catalog.printings(oracle_id) if not p.get("digital")]
    paper.sort(key=lambda p: str(p.get("released_at") or ""), reverse=True)
    return _card_out(card_fields(row), [_printing_out(p, from_index=False) for p in paper])


@router.get("/cards/{oracle_id}")
def get_card(
    session: StorefrontConn,
    os_: Search,
    catalog: Annotated[Catalog, Depends(get_catalog)],
    oracle_id: uuid.UUID,
) -> dict[str, Any]:
    """{card, offers, source}. `card` is the catalog card as search results
    show it (oracle_text as printed, faces, legal, image_*) plus every paper
    `printings` [{id, set_code, set_name, collector_number, rarity,
    finishes, released_at, lang, image_small, image_normal}], newest first.
    `offers` is {printing_id: [offer]} read LIVE from Postgres (priced,
    available after holdback; offer = {inventory_item_id, printing_id, game,
    condition, finish, lang, price_cents, available}) — only printings with
    stock appear. `source` is "index", or "mtg-api" when OpenSearch is down."""
    oid, source = str(oracle_id), "index"
    try:
        card = card_from_index(os_, oid)
    except OpenSearchError:
        card, source = card_from_mtg_api(catalog, oid), "mtg-api"
    if card is None:
        raise HTTPException(404, "no such card")
    ids = [uuid.UUID(p["id"]) for p in card["printings"]]
    offers: dict[str, list[dict[str, Any]]] = {}
    for i in range(0, len(ids), storefront.OFFER_PRINTINGS_MAX):
        chunk = ids[i : i + storefront.OFFER_PRINTINGS_MAX]
        for pid, rows in storefront.storefront_offers(session.conn, session.store, chunk).items():
            offers[str(pid)] = rows
    return {"card": card, "offers": jsonable_encoder(offers), "source": source}


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
