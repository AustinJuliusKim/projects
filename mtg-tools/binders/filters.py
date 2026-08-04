"""Filtering cards.

`where()` covers the common cases through keyword criteria. Anything it can't
express is a predicate — a plain `Card -> bool` callable — which `where()` also
accepts positionally, so the two styles mix freely::

    where(cards, price_min=20, rarity_in=["rare", "mythic"])
    where(cards, any_of(is_rarity("mythic"), price_min_pred(50)))
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Callable, Iterable, Sequence

from .model import Card, Collection, money, normalize_title

__all__ = [
    "where",
    "all_of",
    "any_of",
    "negate",
    "price_between",
    "is_rarity",
    "is_edition",
    "title_matches",
    "is_foil",
    "in_tier",
    "from_source",
    "CRITERIA",
]

Predicate = Callable[[Card], bool]


# --- combinators ------------------------------------------------------------


def all_of(*predicates: Predicate) -> Predicate:
    return lambda card: all(p(card) for p in predicates)


def any_of(*predicates: Predicate) -> Predicate:
    return lambda card: any(p(card) for p in predicates)


def negate(predicate: Predicate) -> Predicate:
    return lambda card: not predicate(card)


# --- predicate builders -----------------------------------------------------


def price_between(minimum=None, maximum=None) -> Predicate:
    """Inclusive lower bound, exclusive upper — so tiers tile without overlap."""
    low = money(minimum) if minimum is not None else None
    high = money(maximum) if maximum is not None else None

    def predicate(card: Card) -> bool:
        if low is not None and card.market_price < low:
            return False
        if high is not None and card.market_price >= high:
            return False
        return True

    return predicate


def is_rarity(*rarities: str) -> Predicate:
    wanted = {r.strip().casefold() for r in _flatten(rarities)}
    return lambda card: card.rarity in wanted


def is_edition(*editions: str) -> Predicate:
    wanted = {e.strip().casefold() for e in _flatten(editions)}
    return lambda card: card.edition.casefold() in wanted


def title_matches(text: str, *, exact: bool = False, front_only: bool = False) -> Predicate:
    needle = normalize_title(text, front_only=front_only)

    def predicate(card: Card) -> bool:
        haystack = normalize_title(card.title, front_only=front_only)
        return haystack == needle if exact else needle in haystack

    return predicate


def is_foil(value: bool = True) -> Predicate:
    return lambda card: card.foil is bool(value)


def in_tier(*tiers: str) -> Predicate:
    wanted = {t.strip().casefold() for t in _flatten(tiers)}
    return lambda card: card.tier in wanted


def from_source(*sources: str) -> Predicate:
    wanted = {s.strip().casefold() for s in _flatten(sources)}
    return lambda card: any(s.casefold() in wanted for s in card.sources)


def _flatten(values) -> list:
    out = []
    for value in values:
        if isinstance(value, (list, tuple, set, frozenset)):
            out.extend(value)
        else:
            out.append(value)
    return out


# --- the keyword DSL --------------------------------------------------------
#
# Each entry maps a `where()` keyword to a function building its predicate.

CRITERIA = {
    "price_min": lambda v: (lambda c: c.market_price >= money(v)),
    "price_max": lambda v: (lambda c: c.market_price <= money(v)),
    "value_min": lambda v: (lambda c: c.total_value >= money(v)),
    "value_max": lambda v: (lambda c: c.total_value <= money(v)),
    "qty_min": lambda v: (lambda c: c.quantity >= int(v)),
    "qty_max": lambda v: (lambda c: c.quantity <= int(v)),
    "rarity": lambda v: is_rarity(v),
    "rarity_in": lambda v: is_rarity(v),
    "edition": lambda v: is_edition(v),
    "edition_in": lambda v: is_edition(v),
    "tier": lambda v: in_tier(v),
    "tier_in": lambda v: in_tier(v),
    "foil": lambda v: is_foil(v),
    "language": lambda v: (lambda c: c.language.casefold() == str(v).casefold()),
    "condition": lambda v: (lambda c: c.condition.casefold() == str(v).casefold()),
    "title": lambda v: title_matches(v, exact=True),
    "title_contains": lambda v: title_matches(v),
    "set_name_contains": lambda v: (
        lambda c: normalize_title(str(v)) in normalize_title(c.set_name)
    ),
    "source_in": lambda v: from_source(v),
    "added_after": lambda v: (lambda c: c.added is not None and c.added >= _as_dt(v)),
    "added_before": lambda v: (lambda c: c.added is not None and c.added <= _as_dt(v)),
    "is_split": lambda v: (lambda c: c.is_split is bool(v)),
}


def _as_dt(value) -> datetime:
    if isinstance(value, datetime):
        return value
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def where(cards: Iterable[Card], *predicates: Predicate, **criteria) -> Collection:
    """Filter `cards` by every predicate and criterion given (logical AND).

    Unknown keywords raise rather than silently matching everything — a typo'd
    filter that quietly returns the whole collection is the kind of bug that
    ends up in a submitted buylist.
    """
    checks = list(predicates)
    for key, value in criteria.items():
        if key not in CRITERIA:
            close = ", ".join(sorted(CRITERIA))
            raise TypeError(f"unknown filter {key!r}; available: {close}")
        if value is None:
            continue
        checks.append(CRITERIA[key](value))

    if not checks:
        return Collection(cards)
    return Collection(card for card in cards if all(check(card) for check in checks))
