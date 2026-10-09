"""MTGJSON open-lane prices (MIT). Reads the flat CSV tables rather than
AllPricesToday.json: cardPrices.csv holds the same day of data as one row
per (uuid, provider, listing, finish), so it streams through the stdlib csv
module instead of parsing one large JSON document. cardIdentifiers.csv maps
MTGJSON uuids to Scryfall printing ids.

Only paper prices are kept; MTGO (Cardhoarder) has no paper SKU."""

import csv
from collections.abc import Iterable, Iterator
from datetime import date

from mtg_api.prices.money import to_cents
from mtg_api.prices.sources import Obs

PRICES_URL = "https://mtgjson.com/api/v5/csv/cardPrices.csv.gz"
IDENTIFIERS_URL = "https://mtgjson.com/api/v5/csv/cardIdentifiers.csv.gz"
META_URL = "https://mtgjson.com/api/v5/csv/meta.csv"

PROVIDERS = {
    "tcgplayer": "mtgjson_tcgplayer",
    "cardkingdom": "mtgjson_cardkingdom",
    "cardsphere": "mtgjson_cardsphere",
    "manapool": "mtgjson_manapool",
    "cardmarket": "mtgjson_cardmarket",
}
FINISH_MAP = {"normal": "nonfoil", "foil": "foil", "etched": "etched"}
LISTING_COL = {"retail": "retail_cents", "buylist": "buylist_cents"}


def parse_identifiers(lines: Iterable[str]) -> dict[str, str]:
    """MTGJSON uuid -> Scryfall printing id, for rows that have one."""
    return {
        row["uuid"]: row["scryfallId"] for row in csv.DictReader(lines) if row.get("scryfallId")
    }


def observations(
    lines: Iterable[str],
    uuid_to_printing: dict[str, str],
    skipped: dict[str, int] | None = None,
) -> Iterator[Obs]:
    """One Obs per CSV line with a usable paper price. `skipped` (if given)
    counts dropped lines by reason for the run summary."""
    skipped = skipped if skipped is not None else {}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    for row in csv.DictReader(lines):
        if row["gameAvailability"] != "paper":
            skip("not_paper")
            continue
        source = PROVIDERS.get(row["priceProvider"])
        finish = FINISH_MAP.get(row["cardFinish"])
        col = LISTING_COL.get(row["providerListing"])
        if source is None or finish is None or col is None:
            skip("unknown_provider_or_finish")
            continue
        printing_id = uuid_to_printing.get(row["uuid"])
        if printing_id is None:
            skip("no_scryfall_id")
            continue
        cents = to_cents(row["price"])
        if cents is None:
            skip("bad_price")
            continue
        obs = Obs(
            printing_id=printing_id,
            finish=finish,
            source=source,
            as_of=date.fromisoformat(row["date"]),
            mtgjson_uuid=row["uuid"],
        )
        setattr(obs, col, cents)
        yield obs
