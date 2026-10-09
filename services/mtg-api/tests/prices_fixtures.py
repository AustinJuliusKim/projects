"""Shared price-snapshot fixtures for test_prices.py and test_prices_api.py:
offline feeds built from tests/fixtures, shifted to any day and optionally
repriced, so tests can build multi-day, multi-revision history without the
network."""

import copy
import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

from mtg_api.prices import fx
from mtg_api.prices.run import run_snapshot
from mtg_api.prices.sources import cardmarket_guide, mtgjson, scryfall

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIXTURE_DAY = date(2026, 10, 8)

BOLT = "7673784e-db4b-43a1-8d55-1bb9fc1e284f"
BLOOD = "0e8ccfa7-4178-476a-a155-0ca1c98556c9"
BALLISTA = "5272436e-74f0-44c4-a291-ea8ebc3f1525"
BLOOD_UUID = "00000000-0000-5000-8000-000000000002"


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def fx_rate():
    return fx.parse_ecb_usd(read("ecb_daily.xml"))


def mtgjson_lines(day: date, scale: dict[str, Decimal] | None = None) -> list[str]:
    """cardPrices.csv for `day`, with each listed uuid's prices multiplied."""
    scale = scale or {}
    lines = read("mtgjson_cardPrices.csv").replace(FIXTURE_DAY.isoformat(), day.isoformat())
    out = []
    for line in lines.splitlines():
        parts = line.split(",")
        if parts[-1] in scale and parts[4]:
            parts[4] = str((Decimal(parts[4]) * scale[parts[-1]]).quantize(Decimal("0.01")))
        out.append(",".join(parts))
    return out


def feeds(day: date, scale: dict[str, Decimal] | None = None, fail: str | None = None):
    """Feed callables shaped like run.py's, reading fixtures for `day`."""
    uuid_map = mtgjson.parse_identifiers(read("mtgjson_cardIdentifiers.csv").splitlines())
    published = datetime(day.year, day.month, day.day, 9)

    def mtgjson_feed(conn, client):
        if fail == "mtgjson":
            raise RuntimeError("mtgjson down")
        return mtgjson.observations(mtgjson_lines(day, scale), uuid_map), published

    def cardmarket_feed(conn, client):
        doc = copy.deepcopy(json.loads(read("cardmarket_price_guide.json")))
        doc["createdAt"] = f"{day.isoformat()}T02:45:29+00:00"
        product_map: dict[int, list[str]] = {}
        for cm_id, printing_id in conn.execute(
            "SELECT cardmarket_id, id FROM printings WHERE cardmarket_id IS NOT NULL"
        ):
            product_map.setdefault(cm_id, []).append(str(printing_id))
        return cardmarket_guide.observations(doc, product_map), published

    def scryfall_feed(conn, client):
        return scryfall.observations(conn, day), published

    return {
        "mtgjson": mtgjson_feed,
        "cardmarket_guide": cardmarket_feed,
        "scryfall": scryfall_feed,
    }


def snapshot_day(conn, day: date, scale=None, fail=None, changelog=None):
    result, _ = run_snapshot(
        conn, feeds(day, scale, fail), day, None, fx_rate=fx_rate(), changelog=changelog
    )
    return result


def build_history(conn, last_day: date, days: int = 31):
    """`days` daily snapshots ending at last_day; Exquisite Blood climbs 1%
    a day so 1d/7d/30d movers exist."""
    results = []
    for i in range(days - 1, -1, -1):
        day = last_day - timedelta(days=i)
        factor = Decimal("1.01") ** (days - 1 - i)
        results.append(snapshot_day(conn, day, scale={BLOOD_UUID: factor}))
    return results
