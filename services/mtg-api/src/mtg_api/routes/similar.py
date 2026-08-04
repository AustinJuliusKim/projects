import uuid
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query

from mtg_api import queries
from mtg_api.deps import get_conn
from mtg_api.routes.models import SimilarCard
from mtg_api.similar.engine import rank_similar

router = APIRouter(prefix="/cards", tags=["similar"])

Conn = Annotated[psycopg.Connection, Depends(get_conn)]


@router.get("/{oracle_id}/similar", response_model=list[SimilarCard])
def similar(
    conn: Conn,
    oracle_id: uuid.UUID,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    format: Annotated[str | None, Query(pattern=r"^[a-z]{2,20}$")] = None,  # noqa: A002
    identity: Annotated[str | None, Query(pattern=r"^[WUBRGCwubrgc]{1,6}$")] = None,
    min_confidence: Annotated[float, Query(ge=0.0, le=1.0)] = 0.0,
) -> list[SimilarCard]:
    seed = queries.card_by_id(conn, str(oracle_id))
    if seed is None:
        raise HTTPException(404, "no card with that oracle_id")
    if not queries.embedding_exists(conn, str(oracle_id)):
        raise HTTPException(404, "no embedding for this card yet — try again after the next ingest")
    results = rank_similar(
        conn,
        seed,
        limit=limit,
        format_=format,
        identity=identity,
        min_confidence=min_confidence,
    )
    return [SimilarCard(**r) for r in results]
