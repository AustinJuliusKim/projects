"""Cardmarket's public price guide for Magic (idGame 1), EUR. Keyed by
Cardmarket idProduct, which Scryfall ships as cardmarket_id and phase A
stores on printings, so no MTGJSON crosswalk is needed. Attributed, never
re-sold as a feed (vault: "Price Data Licensing Lanes")."""

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from mtg_api.prices.money import to_cents
from mtg_api.prices.sources import Obs

GUIDE_URL = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json"

# finish -> (low, trend, avg) keys in a priceGuides entry.
FIELDS = {
    "nonfoil": ("low", "trend", "avg"),
    "foil": ("low-foil", "trend-foil", "avg-foil"),
}


def created_at(doc: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(doc["createdAt"]).astimezone(UTC)


def observations(doc: dict[str, Any], product_to_printings: dict[int, list[str]]) -> Iterator[Obs]:
    observed = created_at(doc)
    for entry in doc["priceGuides"]:
        printings = product_to_printings.get(entry.get("idProduct"))
        if not printings:
            continue
        for finish, keys in FIELDS.items():
            low, trend, avg = (to_cents(entry.get(k)) for k in keys)
            if low is None and trend is None and avg is None:
                continue
            for printing_id in printings:
                yield Obs(
                    printing_id=printing_id,
                    finish=finish,
                    source="cardmarket_guide",
                    as_of=observed.date(),
                    low_cents=low,
                    trend_cents=trend,
                    market_cents=avg,
                    observed_at=observed,
                )
