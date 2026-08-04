from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from mtg_api import queries
from mtg_api.deps import get_conn
from mtg_api.routes.models import Set

router = APIRouter(prefix="/sets", tags=["sets"])

Conn = Annotated[psycopg.Connection, Depends(get_conn)]


@router.get("", response_model=list[Set])
def all_sets(conn: Conn) -> list[Set]:
    return [Set(**s) for s in queries.all_sets(conn)]


@router.get("/{code}", response_model=Set)
def by_code(conn: Conn, code: str) -> Set:
    row = queries.set_by_code(conn, code)
    if row is None:
        raise HTTPException(404, "no set with that code")
    return Set(**row)
