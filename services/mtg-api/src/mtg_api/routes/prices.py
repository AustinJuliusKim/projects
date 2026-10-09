"""/v1/prices — daily price snapshots (vault: "TCG Pricing API Design
2026-09" §5). Responses are keyed to a snapshot: each carries
X-Price-Snapshot and an ETag over its exact bytes, and is cacheable until
the next 21:00 UTC snapshot (forever when pinned to an explicit snapshot,
since snapshots never change)."""

import hashlib
import json
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

from mtg_api.deps import get_conn
from mtg_api.prices import read
from mtg_api.routes.models import (
    MoversResponse,
    PriceBatchRequest,
    PriceBatchResponse,
    PriceHistory,
    PriceObject,
    PriceStatus,
    SetPrices,
    SnapshotManifest,
)

router = APIRouter(prefix="/prices", tags=["prices"])

Conn = Annotated[psycopg.Connection, Depends(get_conn)]

BATCH_MAX = 200
HISTORY_MAX_DAYS = 366
STATUS_MAX_AGE = 60
PINNED_MAX_AGE = 31_536_000


def _cache_seconds() -> int:
    return max(60, int((read.next_snapshot_at() - datetime.now(UTC)).total_seconds()))


def snapshot_response(
    request: Request, payload: BaseModel, snapshot_id: str | None, max_age: int | None = None
) -> Response:
    body = json.dumps(payload.model_dump(mode="json"), separators=(",", ":")).encode()
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    age = _cache_seconds() if max_age is None else max_age
    headers = {"ETag": etag, "Cache-Control": f"public, max-age={age}"}
    if age == PINNED_MAX_AGE:
        headers["Cache-Control"] += ", immutable"
    if snapshot_id:
        headers["X-Price-Snapshot"] = snapshot_id
    candidates = {
        tag.strip().removeprefix("W/")
        for tag in request.headers.get("if-none-match", "").split(",")
    }
    if etag in candidates or "*" in candidates:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


def _game(game: str) -> str:
    if game not in read.GAMES:
        raise HTTPException(404, f"unknown game {game!r}; supported: {', '.join(read.GAMES)}")
    return game


def _latest(conn: psycopg.Connection, game: str) -> dict:
    snap = read.latest_snapshot(conn, game)
    if snap is None:
        raise HTTPException(404, "no price snapshot published yet")
    return snap


def _pinned(conn: psycopg.Connection, game: str, snapshot_id: str | None) -> tuple[dict, bool]:
    if snapshot_id is None:
        return _latest(conn, game), False
    snap = read.snapshot_by_id(conn, game, snapshot_id)
    if snap is None:
        raise HTTPException(404, "no snapshot with that id")
    return snap, True


@router.get("/status", response_model=PriceStatus)
def status(request: Request, conn: Conn, game: str = "mtg") -> Response:
    _game(game)
    snap = read.latest_snapshot(conn, game)
    payload = PriceStatus(
        game=game,
        snapshot_id=snap["snapshot_id"] if snap else None,
        as_of=snap["as_of"] if snap else None,
        next_snapshot_at=read.next_snapshot_at(),
        sources=read.source_status(conn),
    )
    return snapshot_response(
        request, payload, snap["snapshot_id"] if snap else None, max_age=STATUS_MAX_AGE
    )


@router.get("/snapshots", response_model=list[SnapshotManifest])
def snapshots(
    conn: Conn, game: str = "mtg", limit: Annotated[int, Query(ge=1, le=100)] = 30
) -> list[SnapshotManifest]:
    _game(game)
    return [SnapshotManifest(**s) for s in read.list_snapshots(conn, game, limit)]


@router.get("/snapshots/{snapshot_id}", response_model=SnapshotManifest)
def snapshot(request: Request, conn: Conn, snapshot_id: str, game: str = "mtg") -> Response:
    _game(game)
    snap = read.snapshot_by_id(conn, game, snapshot_id)
    if snap is None:
        raise HTTPException(404, "no snapshot with that id")
    return snapshot_response(request, SnapshotManifest(**snap), snapshot_id, max_age=PINNED_MAX_AGE)


@router.post("/batch", response_model=PriceBatchResponse)
def batch(conn: Conn, body: PriceBatchRequest) -> PriceBatchResponse:
    if len(body.items) > BATCH_MAX:
        raise HTTPException(422, f"at most {BATCH_MAX} items per batch")
    snap = _latest(conn, "mtg")
    results = []
    for item in body.items:
        if item.game not in read.GAMES:
            results.append({"query": item, "prices": [], "error": "unknown game"})
            continue
        sku_ids = read.skus_for_lookup(conn, item.game, item.model_dump())
        prices = read.price_objects(conn, item.game, sku_ids, snap)
        results.append({"query": item, "prices": prices, "error": None if prices else "not found"})
    return PriceBatchResponse(snapshot_id=snap["snapshot_id"], results=results)


@router.get("/{game}/movers", response_model=MoversResponse)
def movers(
    request: Request,
    conn: Conn,
    game: str,
    window: Literal["1d", "7d", "30d"] = "1d",
    direction: Literal["up", "down"] = "up",
    min_price: Annotated[int, Query(ge=0, description="cents")] = 0,
    min_change: Annotated[float, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=50)] = 50,
    snapshot_id: Annotated[str | None, Query(alias="snapshot")] = None,
) -> Response:
    _game(game)
    snap, pinned = _pinned(conn, game, snapshot_id)
    rows = read.movers(conn, snap["seq"], int(window[:-1]), direction, min_price, min_change, limit)
    payload = MoversResponse(
        game=game,
        snapshot_id=snap["snapshot_id"],
        window=window,
        direction=direction,
        source=read.CHANGE_SOURCE,
        currency="USD",
        movers=rows,
    )
    return snapshot_response(
        request, payload, snap["snapshot_id"], PINNED_MAX_AGE if pinned else None
    )


@router.get("/{game}/sets/{set_code}", response_model=SetPrices)
def set_prices(request: Request, conn: Conn, game: str, set_code: str) -> Response:
    _game(game)
    snap = _latest(conn, game)
    sku_ids = read.skus_in_set(conn, game, set_code)
    if not sku_ids:
        raise HTTPException(404, "no priced SKUs in that set")
    payload = SetPrices(
        game=game,
        set_code=set_code.lower(),
        snapshot_id=snap["snapshot_id"],
        prices=read.price_objects(conn, game, sku_ids, snap),
    )
    return snapshot_response(request, payload, snap["snapshot_id"])


@router.get("/{game}/{sku_id}/history", response_model=PriceHistory)
def price_history(
    request: Request,
    conn: Conn,
    game: str,
    sku_id: int,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
    series: str | None = None,
    snapshot_id: Annotated[str | None, Query(alias="snapshot")] = None,
) -> Response:
    _game(game)
    snap, pinned = _pinned(conn, game, snapshot_id)
    names = [s.strip() for s in series.split(",")] if series else list(read.SERIES)
    unknown = [s for s in names if s not in read.SERIES]
    if unknown:
        raise HTTPException(
            422, f"unknown series {', '.join(unknown)}; choose from {', '.join(read.SERIES)}"
        )
    end = min(to_date or snap["as_of"], snap["as_of"])
    start = from_date or end - timedelta(days=29)
    if start > end:
        raise HTTPException(422, "from must be on or before to")
    next_from = None
    if (end - start).days + 1 > HISTORY_MAX_DAYS:
        next_from = start + timedelta(days=HISTORY_MAX_DAYS)
        end = next_from - timedelta(days=1)
    if not read.price_objects(conn, game, [sku_id], snap):
        raise HTTPException(404, "no SKU with that id")
    payload = PriceHistory(
        game=game,
        sku_id=sku_id,
        snapshot_id=snap["snapshot_id"],
        from_date=start,
        to_date=end,
        next_from=next_from,
        series=read.history(conn, sku_id, snap["seq"], start, end, names),
    )
    return snapshot_response(
        request, payload, snap["snapshot_id"], PINNED_MAX_AGE if pinned else None
    )


@router.get("/{game}/{sku_id}", response_model=PriceObject)
def price(request: Request, conn: Conn, game: str, sku_id: int) -> Response:
    _game(game)
    snap = _latest(conn, game)
    objects = read.price_objects(conn, game, [sku_id], snap)
    if not objects:
        raise HTTPException(404, "no SKU with that id")
    return snapshot_response(request, PriceObject(**objects[0]), snap["snapshot_id"])
