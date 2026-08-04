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
