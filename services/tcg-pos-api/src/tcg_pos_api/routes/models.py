"""Request/response models — the public shape of the API. Kept independent
of the DB row shape so schema changes stay deliberate. Money is always
integer cents; None means unknown, never 0."""

import datetime
import uuid
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    Field,
    StringConstraints,
    field_validator,
)

Condition = Literal["NM", "LP", "MP", "HP", "DMG"]
Finish = Literal["nonfoil", "foil", "etched"]
Channel = Literal["pos", "web", "ebay", "manapool", "cardtrader", "tcgplayer", "adjustment"]
# Part of the inventory grain. Only MTG has a catalog (mtg-api) today; adding
# a game is a Literal + CHECK change (migrations/0004), not a grain change.
Game = Literal["mtg"]

# Postgres `integer` bound — larger values 422 here instead of erroring in SQL.
INT32_MAX = 2**31 - 1
REASON_MAX = 500


def no_nul(v: str) -> str:
    # Postgres text can't hold NUL; reject it here instead of a 500 from SQL.
    if "\x00" in v:
        raise ValueError("must not contain NUL bytes")
    return v


def _lower_strip(v: object) -> object:
    return v.strip().lower() if isinstance(v, str) else v


# Free text that lands in the ledger/audit: trimmed, non-blank, bounded.
Reason = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=REASON_MAX),
    AfterValidator(no_nul),
]
# Scryfall-style language code ("en", "ja", "zhs"), case-normalised first so
# "EN" and "en" can't become two grains. Mirrored by a CHECK in 0004.
Lang = Annotated[str, BeforeValidator(_lower_strip), StringConstraints(pattern=r"^[a-z]{2,3}$")]


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
    game: Game = "mtg"
    condition: Condition
    finish: Finish
    lang: Lang = "en"
    delta: int = Field(
        ..., strict=True, ge=-INT32_MAX, le=INT32_MAX, description="Signed qty change; never 0"
    )
    reason: Reason
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
    reason: Reason
