import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query

from mtg_api import queries
from mtg_api.deps import get_conn
from mtg_api.routes.models import Autocomplete, Card, Printing, Ruling, SearchPage

router = APIRouter(prefix="/cards", tags=["cards"])

Conn = Annotated[psycopg.Connection, Depends(get_conn)]


# Static paths must be declared before /{oracle_id} so they aren't captured.
@router.get("/named", response_model=Card)
def named(
    conn: Conn,
    exact: Annotated[str | None, Query(min_length=1)] = None,
    fuzzy: Annotated[str | None, Query(min_length=1)] = None,
) -> Card:
    if bool(exact) == bool(fuzzy):
        raise HTTPException(400, "provide exactly one of ?exact= or ?fuzzy=")
    row = (
        queries.card_by_exact_name(conn, exact)
        if exact
        else queries.card_by_fuzzy_name(conn, fuzzy)
    )
    if row is None:
        raise HTTPException(404, "no card matches that name")
    return Card(**row)


@router.get("/search", response_model=SearchPage)
def search(
    conn: Conn,
    q: Annotated[str | None, Query(max_length=200)] = None,
    color: Annotated[str | None, Query(pattern=r"^[WUBRGCwubrgc]{1,6}$")] = None,
    identity: Annotated[str | None, Query(pattern=r"^[WUBRGCwubrgc]{1,6}$")] = None,
    type: Annotated[str | None, Query(max_length=60)] = None,  # noqa: A002
    keyword: Annotated[str | None, Query(max_length=40)] = None,
    mv: Annotated[float | None, Query(ge=0)] = None,
    mv_lte: Annotated[float | None, Query(ge=0)] = None,
    mv_gte: Annotated[float | None, Query(ge=0)] = None,
    format: Annotated[str | None, Query(pattern=r"^[a-z]{2,20}$")] = None,  # noqa: A002
    order: Annotated[str, Query(pattern=r"^(name|mv|edhrec)$")] = "name",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> SearchPage:
    total, rows = queries.search_cards(
        conn,
        q=q,
        color=color,
        identity=identity,
        type_=type,
        keyword=keyword,
        mv=mv,
        mv_lte=mv_lte,
        mv_gte=mv_gte,
        format_=format,
        order=order,
        page=page,
        page_size=page_size,
    )
    return SearchPage(total=total, page=page, page_size=page_size, cards=[Card(**r) for r in rows])


@router.get("/autocomplete", response_model=Autocomplete)
def autocomplete(
    conn: Conn, q: Annotated[str, Query(min_length=2, max_length=100)]
) -> Autocomplete:
    return Autocomplete(names=queries.autocomplete(conn, q))


@router.get("/random", response_model=Card)
def random(conn: Conn) -> Card:
    row = queries.random_card(conn)
    if row is None:
        raise HTTPException(404, "no cards ingested yet")
    return Card(**row)


@router.get("/{oracle_id}", response_model=Card)
def by_id(conn: Conn, oracle_id: uuid.UUID) -> Card:
    row = queries.card_by_id(conn, str(oracle_id))
    if row is None:
        raise HTTPException(404, "no card with that oracle_id")
    return Card(**row)


@router.get("/{oracle_id}/rulings", response_model=list[Ruling])
def rulings(conn: Conn, oracle_id: uuid.UUID) -> list[Ruling]:
    if queries.card_by_id(conn, str(oracle_id)) is None:
        raise HTTPException(404, "no card with that oracle_id")
    return [Ruling(**r) for r in queries.rulings_for(conn, str(oracle_id))]


@router.get("/{oracle_id}/printings", response_model=list[Printing])
def printings(conn: Conn, oracle_id: uuid.UUID) -> list[Printing]:
    if queries.card_by_id(conn, str(oracle_id)) is None:
        raise HTTPException(404, "no card with that oracle_id")
    return [Printing(**p) for p in queries.printings_for(conn, str(oracle_id))]
