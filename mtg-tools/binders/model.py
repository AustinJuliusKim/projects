"""Core data model for ManaBox binder exports.

A `Card` is one row of a ManaBox CSV export, parsed into real types. A
`Collection` is an immutable sequence of them with a few chaining conveniences.

Money is `Decimal` throughout. ManaBox emits prices as plain decimal strings and
the project's totals are reconciled to the cent against hand-built tables, so
float arithmetic is not an option here.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal
from typing import Callable, Iterable, Iterator, Mapping, Optional, Sequence, Tuple

__all__ = [
    "Card",
    "Collection",
    "Tier",
    "TIER_PRIME",
    "TIER_MID",
    "TIER_BULK",
    "TIER_ORDER",
    "RARITY_ORDER",
    "normalize_title",
    "front_face",
    "money",
]


# --- tiers ------------------------------------------------------------------
#
# Thresholds and buylist rates come from the CK Buylist Estimates table in
# ObsidianVault 30-projects/Paternity Leave Project Plan.md. They reproduce that
# table exactly; see tests/test_aggregate.py.

TIER_PRIME = "prime"
TIER_MID = "mid"
TIER_BULK = "bulk"

TIER_ORDER = (TIER_PRIME, TIER_MID, TIER_BULK)

RARITY_ORDER = ("mythic", "rare", "uncommon", "common")


@dataclass(frozen=True)
class Tier:
    """A price band and the buylist rates Card Kingdom tends to pay for it."""

    name: str
    floor: Decimal
    cash_rate: Decimal
    credit_rate: Decimal
    label: str

    def contains(self, price: Decimal) -> bool:
        return price >= self.floor


def money(value) -> Decimal:
    """Coerce to Decimal without ever routing through float."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        # Explicit: str() first so 2.675 doesn't become 2.67499999...
        return Decimal(str(value))
    text = str(value).strip()
    if not text:
        return Decimal("0")
    # Tolerate "$1,234.56" in case a hand-edited file sneaks one in.
    text = text.replace("$", "").replace(",", "")
    return Decimal(text)


# --- title normalization ----------------------------------------------------

_PUNCT_KEEP = {" "}


def front_face(title: str) -> str:
    """The front face of a split/modal card.

    "Invasion of Shandalar // Leyline Surge" -> "Invasion of Shandalar"
    """
    if " // " in title:
        return title.split(" // ", 1)[0]
    return title


def normalize_title(title: str, *, front_only: bool = False) -> str:
    """Fold a card name to a form suitable for matching across price sources.

    Case-insensitive, accent-stripped, punctuation-free, whitespace-collapsed.
    Vendor buylists spell names inconsistently ("Jotun Grunt" vs "Jötun Grunt",
    "Lim-Dul's Vault" vs "Lim Duls Vault"), so comparisons should go through
    this rather than raw equality.
    """
    if front_only:
        title = front_face(title)
    decomposed = unicodedata.normalize("NFKD", title)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    kept = "".join(
        ch if (ch.isalnum() or ch in _PUNCT_KEEP) else " " for ch in stripped
    )
    return " ".join(kept.split()).casefold()


# --- card -------------------------------------------------------------------


@dataclass(frozen=True)
class Card:
    """One row of a ManaBox export.

    `market_price` is the CSV's "Purchase price" column. ManaBox does not
    actually capture what you paid — the column holds its current market price
    — so it is named for what it is. Cost basis lives in the separate ledger.
    """

    title: str
    edition: str
    foil: bool
    quantity: int
    set_name: str
    collector_number: str
    rarity: str
    manabox_id: str
    scryfall_id: str
    market_price: Decimal
    misprint: bool
    altered: bool
    condition: str
    language: str
    currency: str
    added: Optional[datetime]
    sources: Tuple[str, ...] = ()
    finish: str = ""
    extra: Mapping[str, str] = field(default_factory=dict)

    # -- derived ---------------------------------------------------------

    @property
    def total_value(self) -> Decimal:
        return self.market_price * self.quantity

    @property
    def identity(self) -> Tuple[str, ...]:
        """Key identifying "the same card" for merge and diff.

        Scryfall IDs are stable and unique per printing, so they are preferred.
        Hand-edited rows sometimes lack one, hence the fallback.
        """
        finish = self.finish or ("foil" if self.foil else "normal")
        if self.scryfall_id:
            return (self.scryfall_id, finish)
        return (
            normalize_title(self.title),
            self.edition.casefold(),
            self.collector_number.casefold(),
            finish,
        )

    @property
    def tier(self) -> str:
        if self.market_price >= 20:
            return TIER_PRIME
        if self.market_price >= 5:
            return TIER_MID
        return TIER_BULK

    @property
    def is_split(self) -> bool:
        return " // " in self.title

    @property
    def display_name(self) -> str:
        """Name as written in the vault's tables — "Doubling Season (foil)"."""
        return f"{self.title} (foil)" if self.foil else self.title

    @property
    def normalized_title(self) -> str:
        return normalize_title(self.title)

    # -- transforms ------------------------------------------------------

    def with_quantity(self, quantity: int) -> "Card":
        return replace(self, quantity=quantity)

    def with_sources(self, sources: Iterable[str]) -> "Card":
        return replace(self, sources=tuple(dict.fromkeys(sources)))


# --- collection -------------------------------------------------------------


class Collection(Sequence):
    """An immutable sequence of cards with chaining conveniences.

    Every function in this package also accepts a plain iterable of `Card`, so
    this wrapper is sugar rather than a requirement.
    """

    __slots__ = ("_cards",)

    def __init__(self, cards: Iterable[Card] = ()):
        self._cards: Tuple[Card, ...] = tuple(cards)

    # -- sequence protocol ------------------------------------------------

    def __len__(self) -> int:
        return len(self._cards)

    def __iter__(self) -> Iterator[Card]:
        return iter(self._cards)

    def __getitem__(self, index):
        if isinstance(index, slice):
            return Collection(self._cards[index])
        return self._cards[index]

    def __add__(self, other: Iterable[Card]) -> "Collection":
        return Collection(self._cards + tuple(other))

    def __repr__(self) -> str:
        return f"<Collection {len(self._cards)} rows, {self.total_value} total>"

    def __eq__(self, other) -> bool:
        if isinstance(other, Collection):
            return self._cards == other._cards
        if isinstance(other, (list, tuple)):
            return list(self._cards) == list(other)
        return NotImplemented

    # -- quick rollups ----------------------------------------------------

    @property
    def total_quantity(self) -> int:
        return sum(c.quantity for c in self._cards)

    @property
    def total_value(self) -> Decimal:
        return sum((c.total_value for c in self._cards), Decimal("0"))

    @property
    def sources(self) -> Tuple[str, ...]:
        seen: dict = {}
        for card in self._cards:
            for source in card.sources:
                seen[source] = None
        return tuple(seen)

    # -- constructors -----------------------------------------------------

    @classmethod
    def load(cls, path, source: Optional[str] = None) -> "Collection":
        from .io import load

        return load(path, source=source)

    @classmethod
    def load_many(cls, *paths) -> "Collection":
        from .io import load_many

        return load_many(*paths)

    # -- chaining ---------------------------------------------------------

    def where(self, *predicates, **criteria) -> "Collection":
        from .filters import where

        return where(self._cards, *predicates, **criteria)

    def merged(self) -> "Collection":
        from .aggregate import merge

        return merge(self._cards)

    def sorted_by(self, key, *, reverse: bool = True) -> "Collection":
        keyfunc: Callable[[Card], object]
        keyfunc = key if callable(key) else (lambda c: getattr(c, key))
        return Collection(sorted(self._cards, key=keyfunc, reverse=reverse))

    def top(self, n: int = 20, by: str = "total_value") -> "Collection":
        from .aggregate import top_n

        return top_n(self._cards, n=n, by=by)

    def save(self, path, **kwargs) -> None:
        from .io import save

        save(self._cards, path, **kwargs)
