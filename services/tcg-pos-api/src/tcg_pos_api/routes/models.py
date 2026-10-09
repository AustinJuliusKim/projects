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
    # Optional: set the shelf price in the same transaction (e.g. when
    # receiving stock). Omitted leaves the price as is; it is recorded in
    # the adjust's audit row, never in the quantity ledger.
    price_cents: int | None = Field(None, strict=True, ge=0, le=INT32_MAX)

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


class InventoryPriceUpdate(BaseModel):
    """Set (or clear, with null) an item's shelf price. Price changes are
    audit-logged; the ledger only ever records quantity."""

    price_cents: int | None = Field(..., strict=True, ge=0, le=INT32_MAX)


# --- pricing -----------------------------------------------------------------

BasisPoints = Annotated[int, Field(strict=True, ge=0, le=100_000)]


class PriceRule(BaseModel):
    """Condition multipliers in basis points (10000 = 100%), a floor, and a
    round-up step. See migrations/0005_price_rule.sql for the formula."""

    nm_bp: BasisPoints
    lp_bp: BasisPoints
    mp_bp: BasisPoints
    hp_bp: BasisPoints
    dmg_bp: BasisPoints
    min_price_cents: int = Field(..., strict=True, ge=0, le=INT32_MAX)
    round_up_to_cents: int = Field(..., strict=True, ge=1, le=10_000)


class PriceRuleOut(PriceRule):
    is_default: bool
    updated_at: datetime.datetime | None = None


class PriceSuggestion(BaseModel):
    printing_id: uuid.UUID
    finish: Finish
    condition: Condition
    # None when mtg-api has no USD reference for this printing/finish — never 0.
    suggested_cents: int | None
    reference_cents: int | None
    reference_source: str | None
    multiplier_bp: int
    rule: PriceRule
    # Provenance of the reference, straight from mtg-api.
    snapshot_id: str | None
    sku_id: int | None = None
    sku_condition: str | None = None
    sku_lang: str | None = None
    stale: bool | None = None
    attribution: list[str] = []
    note: str | None = None


# --- TCGplayer import ---------------------------------------------------------


class ImportRow(BaseModel):
    row: int  # line number in the CSV (header is line 1)
    status: Literal["matched", "unmatched", "skipped"]
    reason: str | None = None
    product_name: str | None = None
    set_name: str | None = None
    set_code: str | None = None
    number: str | None = None
    condition: Condition | None = None
    finish: Finish | None = None
    lang: str | None = None
    qty: int | None = None
    price_cents: int | None = None
    printing_id: uuid.UUID | None = None


class ImportChange(BaseModel):
    """One inventory grain the import touches (rows at the same grain are
    summed). `delta` is what the ledger records; 0 means qty is already right."""

    printing_id: uuid.UUID
    condition: Condition
    finish: Finish
    lang: str
    rows: list[int]
    current_qty: int
    target_qty: int
    delta: int
    current_price_cents: int | None
    price_cents: int | None
    item_id: uuid.UUID | None = None


class ImportTotals(BaseModel):
    rows: int
    matched: int
    unmatched: int
    skipped: int
    grains: int
    changed: int
    qty_delta: int


class ImportResult(BaseModel):
    dry_run: bool
    location_id: uuid.UUID
    snapshot_id: str | None
    totals: ImportTotals
    changes: list[ImportChange]
    rows: list[ImportRow]
