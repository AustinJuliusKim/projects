import uuid
from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from mtg_api.deps import get_conn

router = APIRouter(prefix="/feedback", tags=["feedback"])

Conn = Annotated[psycopg.Connection, Depends(get_conn)]


class SuggestionEvent(BaseModel):
    event: Literal["impression", "click", "deck_add", "dismiss"]
    seed_oracle_id: uuid.UUID
    suggested_oracle_id: uuid.UUID
    confidence: float | None = Field(default=None, ge=0, le=1)
    context: str | None = Field(default=None, max_length=40)


class FeedbackResult(BaseModel):
    ok: bool
    stored: int


@router.post("/suggestions", response_model=FeedbackResult)
def suggestions(
    conn: Conn, events: Annotated[list[SuggestionEvent], Field(min_length=1, max_length=50)]
) -> FeedbackResult:
    """Anonymous suggestion-feedback log — the future recommendation model's
    training data. Unknown oracle_ids are dropped (FK), not errors: the
    client fires-and-forgets these."""
    stored = 0
    for e in events:
        try:
            conn.execute(
                "INSERT INTO suggestion_events "
                "(event, seed_oracle_id, suggested_oracle_id, confidence, context) "
                "VALUES (%s, %s, %s, %s, %s)",
                (
                    e.event,
                    str(e.seed_oracle_id),
                    str(e.suggested_oracle_id),
                    e.confidence,
                    e.context,
                ),
            )
            stored += 1
        except psycopg.errors.ForeignKeyViolation:
            continue
    return FeedbackResult(ok=True, stored=stored)
