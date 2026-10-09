from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends

from tcg_pos_api.deps import get_plain_conn

router = APIRouter(tags=["health"])


@router.get("/health")
def health(conn: Annotated[psycopg.Connection, Depends(get_plain_conn)]) -> dict:
    conn.execute("SELECT 1")
    return {"ok": True}
