"""Scryfall's prices, already ingested onto printings by the card ingest.
Open lane, trend only: Scryfall republishes TCGplayer and Cardmarket figures
once a day and forbids paywalling them."""

from datetime import date

import psycopg

from mtg_api.prices.money import to_cents
from mtg_api.prices.sources import Obs

# (printings column, finish, source code)
COLUMNS = (
    ("price_usd", "nonfoil", "scryfall_usd"),
    ("price_usd_foil", "foil", "scryfall_usd"),
    ("price_eur", "nonfoil", "scryfall_eur"),
)


def observations(conn: psycopg.Connection, as_of: date) -> list[Obs]:
    """Eager on purpose: staging COPYs on the same connection, which can't
    run another query while the COPY is open."""
    out = []
    rows = conn.execute(
        "SELECT id, price_usd, price_usd_foil, price_eur, price_updated_at FROM printings "
        "WHERE price_usd IS NOT NULL OR price_usd_foil IS NOT NULL OR price_eur IS NOT NULL"
    ).fetchall()
    for printing_id, usd, usd_foil, eur, updated_at in rows:
        values = {"price_usd": usd, "price_usd_foil": usd_foil, "price_eur": eur}
        for col, finish, source in COLUMNS:
            cents = to_cents(values[col])
            if cents is not None:
                out.append(
                    Obs(
                        printing_id=str(printing_id),
                        finish=finish,
                        source=source,
                        as_of=as_of,
                        trend_cents=cents,
                        observed_at=updated_at,
                    )
                )
    return out
