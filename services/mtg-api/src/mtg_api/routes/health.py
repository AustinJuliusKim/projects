from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends

from mtg_api.deps import get_conn

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz(conn: Annotated[psycopg.Connection, Depends(get_conn)]) -> dict:
    conn.execute("SELECT 1")
    return {"ok": True}
