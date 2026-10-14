"""Money as integer cents. Upstream files carry decimal strings or floats in
major units; Decimal(str(x)) keeps a float's printed value rather than its
binary expansion, so 0.29 becomes 29, not 28."""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any


def to_cents(value: Any) -> int | None:
    """Major units -> cents, or None for missing, unparseable or negative
    values. Never 0 for "no price"."""
    if value is None or value == "":
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount < 0:
        return None
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
