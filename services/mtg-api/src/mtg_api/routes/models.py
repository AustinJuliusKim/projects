"""Response models — the public shape of the API. Kept independent of the
DB row shape so schema changes stay deliberate."""

import datetime
import uuid
from typing import Any

from pydantic import BaseModel


class Card(BaseModel):
    oracle_id: uuid.UUID
    name: str
    mana_cost: str | None = None
    mana_value: float | None = None
    type_line: str | None = None
    oracle_text: str | None = None
    colors: list[str] | None = None
    color_identity: list[str] | None = None
    keywords: list[str] | None = None
    power: str | None = None
    toughness: str | None = None
    loyalty: str | None = None
    defense: str | None = None
    produced_mana: list[str] | None = None
    layout: str | None = None
    legalities: dict[str, str] | None = None
    card_faces: list[dict[str, Any]] | None = None
    reserved: bool = False
    edhrec_rank: int | None = None
    image_small: str | None = None
    image_normal: str | None = None


class SearchPage(BaseModel):
    total: int
    page: int
    page_size: int
    cards: list[Card]


class Autocomplete(BaseModel):
    names: list[str]


class ComboInfo(BaseModel):
    """Structured known-combo data for this result, from card_combo_pairs
    (Commander Spellbook — see migrations/0007_combos.sql). `produces` is
    the feature name(s) the combo produces (e.g. "Infinite colorless
    mana"); `count` is how many distinct Commander Spellbook variants
    contain this pair; `popularity` is that combo's deck-inclusion count
    on Commander Spellbook, used elsewhere as a tie-breaker."""

    produces: list[str]
    count: int
    popularity: int


class SimilarCard(BaseModel):
    oracle_id: uuid.UUID
    name: str
    type_line: str | None = None
    image_normal: str | None = None
    # Calibrated confidence of *mechanical synergy relative to the card
    # pool* — not a win-rate or power-level claim.
    confidence: float
    band: str
    reasons: list[str]
    # None when this pair has no known-combo relationship (most results).
    combo: ComboInfo | None = None


class Ruling(BaseModel):
    published_at: datetime.date | None = None
    comment: str


class Printing(BaseModel):
    id: uuid.UUID
    set_code: str
    set_name: str | None = None
    collector_number: str | None = None
    rarity: str | None = None
    lang: str | None = None
    released_at: datetime.date | None = None
    artist: str | None = None
    finishes: list[str] | None = None
    promo: bool = False
    digital: bool = False
    image_small: str | None = None
    image_normal: str | None = None
    price_usd: float | None = None
    price_usd_foil: float | None = None
    price_eur: float | None = None
    price_tix: float | None = None


class Set(BaseModel):
    code: str
    name: str | None = None
    set_type: str | None = None
    released_at: datetime.date | None = None
    card_count: int | None = None
    icon_svg_uri: str | None = None


# --- Prices (TCG Pricing API design §5). Money is integer cents in the
# source's own currency, never float; a missing price is null, never 0.


class PriceProvenance(BaseModel):
    """Where one source's numbers in `open` came from."""

    source: str
    lane: str
    series: str
    currency: str
    method: str | None = None
    as_of: datetime.date
    observed_at: datetime.datetime | None = None
    stale: bool
    flags: list[str] = []


class PriceObject(BaseModel):
    game: str
    sku_id: int
    printing_id: uuid.UUID
    finish: str
    condition: str
    lang: str
    snapshot_id: str
    as_of: datetime.date
    # Listing-based own index (phase E). Kept as its own object, never
    # blended with `open`; null until the own index exists.
    own: dict[str, Any] | None = None
    # Open-lane figures keyed "<source>_<field>_<currency>", e.g.
    # "mtgjson_tcgplayer_retail_usd": 1410 or "cardmarket_guide_trend_eur": 1190.
    open: dict[str, int]
    change: dict[str, float | None]
    change_source: str
    stale: bool
    attribution: list[str]
    provenance: list[PriceProvenance]


class PriceBatchItem(BaseModel):
    game: str = "mtg"
    sku_id: int | None = None
    tcgplayer_id: int | None = None
    scryfall_id: uuid.UUID | None = None
    set: str | None = None
    number: str | None = None
    finish: str | None = None


class PriceBatchRequest(BaseModel):
    items: list[PriceBatchItem]


class PriceBatchResult(BaseModel):
    query: PriceBatchItem
    prices: list[PriceObject]
    error: str | None = None


class PriceBatchResponse(BaseModel):
    snapshot_id: str
    results: list[PriceBatchResult]


class PricePoint(BaseModel):
    as_of: datetime.date
    values: dict[str, int | None]


class PriceSeries(BaseModel):
    source: str
    currency: str
    points: list[PricePoint]


class PriceHistory(BaseModel):
    game: str
    sku_id: int
    snapshot_id: str
    from_date: datetime.date
    to_date: datetime.date
    next_from: datetime.date | None = None
    series: list[PriceSeries]


class Mover(BaseModel):
    rank: int
    sku_id: int
    printing_id: uuid.UUID
    finish: str
    name: str | None = None
    set_code: str | None = None
    collector_number: str | None = None
    price_cents: int
    change: float


class MoversResponse(BaseModel):
    game: str
    snapshot_id: str
    window: str
    direction: str
    source: str
    currency: str
    movers: list[Mover]


class SetPrices(BaseModel):
    game: str
    set_code: str
    snapshot_id: str
    prices: list[PriceObject]


class SnapshotManifest(BaseModel):
    snapshot_id: str
    game: str
    as_of: datetime.date
    revision: int
    created_at: datetime.datetime
    sources_ok: list[str]
    sources_failed: list[str]
    row_counts: dict[str, int]
    fx_eur_usd: float | None = None
    fx_as_of: datetime.date | None = None
    changelog: str | None = None


class SourceStatus(BaseModel):
    source: str
    name: str
    lane: str
    series: str
    currency: str
    feed: str
    last_success_at: datetime.datetime | None = None
    lag_hours: float | None = None
    stale: bool


class PriceStatus(BaseModel):
    game: str
    snapshot_id: str | None = None
    as_of: datetime.date | None = None
    next_snapshot_at: datetime.datetime
    sources: list[SourceStatus]
