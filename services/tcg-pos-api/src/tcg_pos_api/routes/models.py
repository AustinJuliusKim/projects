"""Request/response models — the public shape of the API. Kept independent
of the DB row shape so schema changes stay deliberate. Money is always
integer cents; None means unknown, never 0."""

import datetime
import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Condition = Literal["NM", "LP", "MP", "HP", "DMG"]
Finish = Literal["nonfoil", "foil", "etched"]
Channel = Literal["pos", "web", "ebay", "manapool", "cardtrader", "tcgplayer", "adjustment"]

# Postgres `integer` bound — larger values 422 here instead of erroring in SQL.
INT32_MAX = 2**31 - 1


class InventoryItem(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    printing_id: uuid.UUID
    game: str
    condition: Condition
    finish: Finish
    lang: str
    qty: int
    price_cents: int | None = None
    updated_at: datetime.datetime


class InventoryPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[InventoryItem]


class InventoryAdjust(BaseModel):
    """Apply `delta` to the item at this grain, creating it (qty 0, unpriced)
    if it doesn't exist yet."""

    location_id: uuid.UUID
    printing_id: uuid.UUID
    game: str = "mtg"
    condition: Condition
    finish: Finish
    lang: str = "en"
    delta: int = Field(
        ..., strict=True, ge=-INT32_MAX, le=INT32_MAX, description="Signed qty change; never 0"
    )
    reason: str = Field(..., min_length=1)
    channel: Channel = "adjustment"

    @field_validator("delta")
    @classmethod
    def _nonzero(cls, v: int) -> int:
        if v == 0:
            raise ValueError("delta must not be 0")
        return v


class InventoryAdjustResult(BaseModel):
    item: InventoryItem
    ledger_id: uuid.UUID


class CreditBalance(BaseModel):
    customer_id: uuid.UUID
    balance_cents: int


class CreditChange(BaseModel):
    # strict: a "12.00" string is almost certainly dollars — refuse to coerce it to 12 cents.
    amount_cents: int = Field(..., strict=True, gt=0, le=INT32_MAX, description="Integer cents")
    reason: str = Field(..., min_length=1)
