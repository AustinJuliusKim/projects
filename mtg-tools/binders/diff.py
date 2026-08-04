"""Comparing two scans of the same collection.

Two uses: figuring out what a re-scan or a manual prune actually changed, and
the quarterly market-value refresh the ledger plan calls for.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, List, Tuple

from .aggregate import cents, merge
from .model import Card, Collection

__all__ = ["Change", "Diff", "diff"]


@dataclass(frozen=True)
class Change:
    """One card that exists in both scans but differs."""

    before: Card
    after: Card

    @property
    def quantity_delta(self) -> int:
        return self.after.quantity - self.before.quantity

    @property
    def price_delta(self) -> Decimal:
        return self.after.market_price - self.before.market_price

    @property
    def value_delta(self) -> Decimal:
        return self.after.total_value - self.before.total_value

    @property
    def name(self) -> str:
        return self.after.display_name


@dataclass(frozen=True)
class Diff:
    added: Collection
    removed: Collection
    quantity_changed: Tuple[Change, ...]
    price_changed: Tuple[Change, ...]
    unchanged: Collection

    @property
    def value_added(self) -> Decimal:
        return cents(self.added.total_value)

    @property
    def value_removed(self) -> Decimal:
        return cents(self.removed.total_value)

    @property
    def value_delta(self) -> Decimal:
        """Net change in total collection value across every bucket."""
        moved = sum(
            (c.value_delta for c in self.quantity_changed + self.price_changed),
            Decimal("0"),
        )
        return cents(self.added.total_value - self.removed.total_value + moved)

    @property
    def quantity_delta(self) -> int:
        moved = sum(c.quantity_delta for c in self.quantity_changed)
        return self.added.total_quantity - self.removed.total_quantity + moved

    def is_empty(self) -> bool:
        return not (
            self.added or self.removed or self.quantity_changed or self.price_changed
        )

    def __repr__(self) -> str:
        return (
            f"<Diff +{len(self.added)} -{len(self.removed)} "
            f"qty~{len(self.quantity_changed)} price~{len(self.price_changed)} "
            f"net {self.value_delta}>"
        )


def diff(old: Iterable[Card], new: Iterable[Card], *, already_merged: bool = False) -> Diff:
    """Compare two collections, keyed on `Card.identity`.

    Both sides are merged first so the comparison is card-to-card rather than
    row-to-row — otherwise splitting one export into two files reads as a
    collection-wide change.

    A card whose quantity *and* price both moved lands in `quantity_changed`
    only, so no card is double-counted in `value_delta`.
    """
    before = {c.identity: c for c in (old if already_merged else merge(old))}
    after = {c.identity: c for c in (new if already_merged else merge(new))}

    added = [card for key, card in after.items() if key not in before]
    removed = [card for key, card in before.items() if key not in after]

    quantity_changed: List[Change] = []
    price_changed: List[Change] = []
    unchanged: List[Card] = []

    for key, new_card in after.items():
        old_card = before.get(key)
        if old_card is None:
            continue
        if old_card.quantity != new_card.quantity:
            quantity_changed.append(Change(old_card, new_card))
        elif old_card.market_price != new_card.market_price:
            price_changed.append(Change(old_card, new_card))
        else:
            unchanged.append(new_card)

    quantity_changed.sort(key=lambda c: abs(c.value_delta), reverse=True)
    price_changed.sort(key=lambda c: abs(c.value_delta), reverse=True)

    return Diff(
        added=Collection(sorted(added, key=lambda c: c.total_value, reverse=True)),
        removed=Collection(sorted(removed, key=lambda c: c.total_value, reverse=True)),
        quantity_changed=tuple(quantity_changed),
        price_changed=tuple(price_changed),
        unchanged=Collection(unchanged),
    )
