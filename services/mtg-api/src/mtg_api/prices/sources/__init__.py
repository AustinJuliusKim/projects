"""Price sources. Each one yields Obs rows for snapshot.stage(); a source
may emit partial rows (MTGJSON's retail and buylist arrive as separate CSV
lines) and staging merges them per (printing, finish, source, as_of)."""

from dataclasses import dataclass
from datetime import date, datetime

# Value columns shared by staging, price_daily and price_current.
VALUE_COLS = (
    "retail_cents",
    "buylist_cents",
    "low_cents",
    "trend_cents",
    "market_cents",
    "market_smooth_cents",
    "mid_cents",
    "listing_count",
    "seller_count",
)


@dataclass(slots=True)
class Obs:
    printing_id: str
    finish: str
    source: str  # price_sources.code
    as_of: date
    retail_cents: int | None = None
    buylist_cents: int | None = None
    low_cents: int | None = None
    trend_cents: int | None = None
    market_cents: int | None = None
    market_smooth_cents: int | None = None
    mid_cents: int | None = None
    listing_count: int | None = None
    seller_count: int | None = None
    method: str = "reference"
    observed_at: datetime | None = None
    mtgjson_uuid: str | None = None
