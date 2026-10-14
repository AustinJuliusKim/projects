"""Suggested-price math. Pure functions, integer cents only — no floats ever
touch money. The rule is documented in migrations/0005_price_rule.sql:

    scaled    = round_half_up(reference_cents * condition_bp / 10000)
    rounded   = scaled rounded UP to a multiple of round_up_to_cents
    suggested = max(rounded, min_price_cents)
"""

from typing import Any

# The USD reference, in preference order: TCGplayer retail (via MTGJSON),
# then Scryfall's USD trend. Both are open-lane keys of mtg-api's price
# object `open` dict ("<source>_<field>_<currency>").
USD_REFERENCE_KEYS = ("mtgjson_tcgplayer_retail_usd", "scryfall_usd_trend_usd")

DEFAULT_RULE: dict[str, int] = {
    "nm_bp": 10000,
    "lp_bp": 9000,
    "mp_bp": 7500,
    "hp_bp": 6000,
    "dmg_bp": 4000,
    "min_price_cents": 25,
    "round_up_to_cents": 25,
}
RULE_FIELDS = tuple(DEFAULT_RULE)


def condition_bp(rule: dict[str, int], condition: str) -> int:
    return rule[f"{condition.lower()}_bp"]


def apply_rule(reference_cents: int, condition: str, rule: dict[str, int]) -> int:
    bp = condition_bp(rule, condition)
    scaled = (reference_cents * bp + 5000) // 10000
    step = rule["round_up_to_cents"]
    rounded = -(-scaled // step) * step
    return max(rounded, rule["min_price_cents"])


def usd_reference(price: dict[str, Any]) -> tuple[str | None, int | None]:
    """(key, cents) of the first USD reference present in a price object's
    open lane, or (None, None). A zero is treated as present (it's data);
    a missing key or null is not."""
    open_values = price.get("open") or {}
    for key in USD_REFERENCE_KEYS:
        value = open_values.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return key, value
    return None, None


def pick_price(prices: list[dict[str, Any]], lang: str = "en") -> dict[str, Any] | None:
    """The price object to base a suggestion on: one with a USD reference,
    preferring the NM SKU in the requested language (the open lane prices NM
    and the condition multiplier does the rest). None if nothing has USD."""
    with_usd = [p for p in prices if usd_reference(p)[1] is not None]
    if not with_usd:
        return None
    return min(
        with_usd,
        key=lambda p: (p.get("condition") != "NM", p.get("lang") != lang),
    )
