"""Merging, grouping and rolling up collections.

`merge()` is the load-bearing one: binder exports are scanned separately, so a
card owned in four copies across three binders looks like three unremarkable
rows until they are collapsed onto one identity.
"""

from __future__ import annotations

import statistics
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from .model import (
    RARITY_ORDER,
    TIER_BULK,
    TIER_MID,
    TIER_ORDER,
    TIER_PRIME,
    Card,
    Collection,
    Tier,
    money,
)

__all__ = [
    "CK_TIERS",
    "TierRow",
    "Summary",
    "merge",
    "group_by",
    "summarize",
    "price_tiers",
    "multi_copies",
    "high_value",
    "top_n",
    "cents",
]


# Rates from the CK Buylist Estimates table in the vault's project plan.
CK_TIERS: Tuple[Tier, ...] = (
    Tier(TIER_PRIME, Decimal("20"), Decimal("0.60"), Decimal("0.75"), "$20+ (prime)"),
    Tier(TIER_MID, Decimal("5"), Decimal("0.47"), Decimal("0.62"), "$5–$19.99 (mid)"),
    Tier(TIER_BULK, Decimal("0"), Decimal("0.20"), Decimal("0.25"), "Under $5 (bulk)"),
)


def cents(value: Decimal) -> Decimal:
    """Round to whole cents, half-up — the way money is rounded on invoices."""
    return money(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# --- merge ------------------------------------------------------------------


def merge(*collections: Iterable[Card], sum_quantities: bool = True) -> Collection:
    """Collapse cards sharing an identity into one row.

    Quantities are summed and `sources` are unioned. Where two scans disagree on
    price — they routinely do, by a few percent, when binders were scanned days
    apart — the most recently scanned price wins, because that is the current
    market value both the buylist estimate and the insurance valuation want.
    This matters at tier boundaries: Black Market Connections scanned at $20.23
    in June and $19.70 in July, which is the difference between the prime and
    mid band.

    Ordering is stable: first appearance wins, which keeps output diffable.
    """
    merged: "OrderedDict[Tuple, Card]" = OrderedDict()

    for collection in collections:
        for card in collection:
            key = card.identity
            existing = merged.get(key)
            if existing is None:
                merged[key] = card
                continue

            quantity = existing.quantity + card.quantity if sum_quantities else existing.quantity
            newest = _newer(existing, card)
            price = newest.market_price
            added = newest.added if newest.added is not None else _latest(existing.added, card.added)
            sources = tuple(dict.fromkeys(existing.sources + card.sources))

            merged[key] = Card(
                title=existing.title,
                edition=existing.edition,
                foil=existing.foil,
                quantity=quantity,
                set_name=existing.set_name,
                collector_number=existing.collector_number,
                rarity=existing.rarity,
                manabox_id=existing.manabox_id,
                scryfall_id=existing.scryfall_id,
                market_price=price,
                misprint=existing.misprint or card.misprint,
                altered=existing.altered or card.altered,
                condition=existing.condition,
                language=existing.language,
                currency=existing.currency,
                added=added,
                sources=sources,
                finish=existing.finish or card.finish,
                extra=dict(existing.extra),
            )

    return Collection(merged.values())


def _latest(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def _newer(existing: Card, candidate: Card) -> Card:
    """Whichever card was scanned more recently; ties keep the incumbent."""
    if candidate.added is None:
        return existing
    if existing.added is None:
        return candidate
    return candidate if candidate.added > existing.added else existing


# --- grouping ---------------------------------------------------------------


def group_by(cards: Iterable[Card], key) -> "OrderedDict[object, Collection]":
    """Group cards by an attribute name or a callable.

    Groups come back sorted by descending total value, which is nearly always
    the order you want to read them in.
    """
    keyfunc: Callable[[Card], object]
    keyfunc = key if callable(key) else (lambda c: getattr(c, key))

    buckets: Dict[object, List[Card]] = defaultdict(list)
    for card in cards:
        buckets[keyfunc(card)].append(card)

    ordered = sorted(
        buckets.items(),
        key=lambda item: sum((c.total_value for c in item[1]), Decimal("0")),
        reverse=True,
    )
    return OrderedDict((name, Collection(group)) for name, group in ordered)


# --- summary ----------------------------------------------------------------


@dataclass(frozen=True)
class Summary:
    rows: int
    distinct: int
    quantity: int
    total_value: Decimal
    mean_price: Decimal
    median_price: Decimal
    max_price: Decimal
    by_rarity: "OrderedDict[str, Tuple[int, Decimal]]"
    by_set: "OrderedDict[str, Tuple[int, Decimal]]"
    by_source: "OrderedDict[str, Tuple[int, Decimal]]"
    foil_quantity: int
    foil_value: Decimal


def summarize(cards: Iterable[Card]) -> Summary:
    cards = list(cards)
    if not cards:
        empty: "OrderedDict[str, Tuple[int, Decimal]]" = OrderedDict()
        zero = Decimal("0.00")
        return Summary(0, 0, 0, zero, zero, zero, zero, empty, empty, empty, 0, zero)

    prices = sorted(card.market_price for card in cards)
    quantity = sum(card.quantity for card in cards)
    total = sum((card.total_value for card in cards), Decimal("0"))

    def rollup(key) -> "OrderedDict[str, Tuple[int, Decimal]]":
        out: "OrderedDict[str, Tuple[int, Decimal]]" = OrderedDict()
        for name, group in group_by(cards, key).items():
            out[str(name)] = (group.total_quantity, cents(group.total_value))
        return out

    def source_rollup() -> "OrderedDict[str, Tuple[int, Decimal]]":
        buckets: Dict[str, List[Card]] = defaultdict(list)
        for card in cards:
            for source in card.sources or ("(untagged)",):
                buckets[source].append(card)
        ordered = sorted(
            buckets.items(),
            key=lambda item: sum((c.total_value for c in item[1]), Decimal("0")),
            reverse=True,
        )
        return OrderedDict(
            (name, (sum(c.quantity for c in group), cents(sum((c.total_value for c in group), Decimal("0")))))
            for name, group in ordered
        )

    foils = [c for c in cards if c.foil]

    return Summary(
        rows=len(cards),
        distinct=len({card.identity for card in cards}),
        quantity=quantity,
        total_value=cents(total),
        mean_price=cents(sum(prices, Decimal("0")) / len(prices)),
        median_price=cents(Decimal(str(statistics.median(prices)))),
        max_price=cents(prices[-1]),
        by_rarity=OrderedDict(
            sorted(
                rollup("rarity").items(),
                key=lambda item: RARITY_ORDER.index(item[0])
                if item[0] in RARITY_ORDER
                else len(RARITY_ORDER),
            )
        ),
        by_set=rollup("set_name"),
        by_source=source_rollup(),
        foil_quantity=sum(c.quantity for c in foils),
        foil_value=cents(sum((c.total_value for c in foils), Decimal("0"))),
    )


# --- price tiers ------------------------------------------------------------


@dataclass(frozen=True)
class TierRow:
    tier: Tier
    cards: Collection
    quantity: int
    market_value: Decimal
    cash: Decimal
    credit: Decimal

    @property
    def label(self) -> str:
        return self.tier.label


def price_tiers(
    cards: Iterable[Card], tiers: Sequence[Tier] = CK_TIERS
) -> "OrderedDict[str, TierRow]":
    """Split a collection into price bands with cash/credit buylist estimates.

    Reproduces the vault's CK Buylist Estimates table. Tiers are tested in the
    order given, highest floor first, so each card lands in exactly one band.
    """
    ordered = sorted(tiers, key=lambda t: t.floor, reverse=True)
    buckets: Dict[str, List[Card]] = {tier.name: [] for tier in ordered}

    for card in cards:
        for tier in ordered:
            if tier.contains(card.market_price):
                buckets[tier.name].append(card)
                break

    rows: "OrderedDict[str, TierRow]" = OrderedDict()
    for tier in ordered:
        group = Collection(buckets[tier.name])
        value = group.total_value
        rows[tier.name] = TierRow(
            tier=tier,
            cards=group,
            quantity=group.total_quantity,
            market_value=cents(value),
            cash=cents(value * tier.cash_rate),
            credit=cents(value * tier.credit_rate),
        )
    return rows


# --- flags ------------------------------------------------------------------


def multi_copies(cards: Iterable[Card], min_qty: int = 2, *, already_merged: bool = False) -> Collection:
    """Cards held in `min_qty` or more copies, richest stack first.

    Merges first by default — a ×13 stack spread across four binders is
    invisible otherwise.
    """
    pool = cards if already_merged else merge(cards)
    stacks = [card for card in pool if card.quantity >= min_qty]
    return Collection(sorted(stacks, key=lambda c: (c.total_value, c.quantity), reverse=True))


def high_value(cards: Iterable[Card], threshold=Decimal("10")) -> Collection:
    """Cards worth a condition check before they go in a buylist box."""
    limit = money(threshold)
    hits = [card for card in cards if card.market_price >= limit]
    return Collection(sorted(hits, key=lambda c: c.total_value, reverse=True))


def top_n(cards: Iterable[Card], n: int = 20, by: str = "total_value") -> Collection:
    keyfunc: Callable[[Card], object]
    keyfunc = by if callable(by) else (lambda c: getattr(c, by))
    return Collection(sorted(cards, key=keyfunc, reverse=True)[:n])
