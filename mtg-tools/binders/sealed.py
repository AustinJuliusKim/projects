"""Sealed commander decks: what you own, what it's worth, and how that moved.

Prices here are entered by hand, on purpose. No free source publishes realized
sale prices for sealed product — TCGplayer's API is closed to new developers,
eBay's sold-comp API is partner-only, and MTGJSON has no sealed prices at all.
Sealed product also moves slowly, so a quarterly pass over a few dozen decks is
tractable in a way it never would be for 543 singles.

What the tool contributes is the part a person is bad at: pinning each line to an
exact product. "Heavenly Inferno" is two different decks six years apart, and a
Collector's Edition is a different, pricier product than its base deck. Those get
reported, never guessed.
"""

from __future__ import annotations

import csv
import difflib
import io
import os
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .aggregate import cents
from .catalog import Catalog, Deck, load_catalog, nickname, split_display
from .model import money

__all__ = [
    "SEALED_COLUMNS",
    "KNOWN_CONDITIONS",
    "TEMPLATE_ROWS",
    "template_csv",
    "SealedHolding",
    "Issue",
    "SealedSummary",
    "SealedChange",
    "SealedDiff",
    "load_sealed",
    "save_sealed",
    "resolve",
    "summarize_sealed",
    "diff_sealed",
    "snapshot_path",
]

SEALED_COLUMNS = (
    "Name",
    "Set",
    "Quantity",
    "Condition",
    "Price",
    "Price date",
    "Source",
    "Cost basis",
    "Notes",
)

#: Sealed product condition is about the box, not the cards.
KNOWN_CONDITIONS = ("sealed", "opened", "damaged")

#: The two example rows in a starter file. One shows the minimum — a name and a
#: quantity — and the other shows why a Set column exists at all: `Heavenly
#: Inferno` is two different decks six years apart, and the printings differ
#: several-fold in price.
TEMPLATE_ROWS = (
    ("Sneak Attack", "", "1", "sealed", "", "", "", "", ""),
    (
        "Heavenly Inferno",
        "CMD",
        "1",
        "sealed",
        "",
        "",
        "",
        "",
        "a Set is only needed when a name is ambiguous",
    ),
)


def template_csv() -> str:
    """A starter `sealed.csv`, as text.

    Lives here rather than in the CLI so the file the web app hands you and the
    file `sealed template` writes cannot drift apart — the columns are the
    parser's contract, and two copies of a contract is one copy too many.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(list(SEALED_COLUMNS))
    for row in TEMPLATE_ROWS:
        writer.writerow(list(row))
    return buffer.getvalue()


MATCH_EXACT = "exact"
MATCH_NICKNAME = "nickname"
MATCH_SUFFIX = "suffix"
MATCH_CONTAINS = "contains"
MATCH_UUID = "uuid"
MATCH_AMBIGUOUS = "ambiguous"
MATCH_UNMATCHED = "unmatched"


@dataclass(frozen=True)
class SealedHolding:
    """One line of `sealed.csv`, plus whatever it resolved to."""

    raw_name: str
    set_hint: str = ""
    quantity: int = 1
    condition: str = "sealed"
    price: Optional[Decimal] = None
    price_date: Optional[date] = None
    source: str = ""
    cost_basis: Optional[Decimal] = None
    notes: str = ""
    line: int = 0

    deck: Optional[Deck] = None
    match: str = MATCH_UNMATCHED
    candidates: Tuple[Deck, ...] = ()

    # -- identity --------------------------------------------------------

    @property
    def resolved(self) -> bool:
        return self.deck is not None

    @property
    def identity(self) -> str:
        """Stable key for diffing across snapshots.

        The MTGJSON UUID when resolved, so renaming a row from a nickname to a
        full product name does not read as a different holding.
        """
        if self.deck is not None:
            return self.deck.uuid
        return "unresolved:" + nickname(self.raw_name)

    @property
    def display(self) -> str:
        if self.deck is not None:
            return self.deck.display
        return f"{self.raw_name} (unmatched)"

    @property
    def set_code(self) -> str:
        return self.deck.set_code if self.deck else self.set_hint

    @property
    def year(self) -> str:
        return self.deck.year if self.deck else ""

    # -- money -----------------------------------------------------------

    @property
    def has_price(self) -> bool:
        return self.price is not None and self.price > 0

    @property
    def total_value(self) -> Decimal:
        """Zero when unpriced. `summarize_sealed` reports the unpriced count
        alongside the total so a partial valuation can't read as complete."""
        if self.price is None:
            return Decimal("0")
        return self.price * self.quantity

    @property
    def total_cost(self) -> Optional[Decimal]:
        if self.cost_basis is None:
            return None
        return self.cost_basis * self.quantity

    @property
    def gain(self) -> Optional[Decimal]:
        cost = self.total_cost
        if cost is None or self.price is None:
            return None
        return self.total_value - cost


@dataclass(frozen=True)
class Issue:
    """Something about a row that needs a human."""

    level: str  # "error" | "warn" | "info"
    code: str
    message: str
    holding: Optional[SealedHolding] = None

    def __str__(self) -> str:
        where = f" (line {self.holding.line})" if self.holding else ""
        return f"{self.level.upper()}: {self.message}{where}"


# --- io ---------------------------------------------------------------------


def _parse_money(value: Optional[str]) -> Optional[Decimal]:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return money(text)
    except (InvalidOperation, ValueError):
        return None


def _parse_date(value: Optional[str]) -> Optional[date]:
    text = (value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def load_sealed(path) -> List[SealedHolding]:
    """Read `sealed.csv`. Unresolved — call `resolve` next."""
    path = os.fspath(path)
    holdings: List[SealedHolding] = []
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for index, row in enumerate(reader, start=2):  # line 1 is the header
            if not any((v or "").strip() for v in row.values()):
                continue
            quantity_raw = (row.get("Quantity") or "1").strip()
            holdings.append(
                SealedHolding(
                    raw_name=(row.get("Name") or "").strip(),
                    set_hint=(row.get("Set") or "").strip(),
                    quantity=int(quantity_raw) if quantity_raw.lstrip("-").isdigit() else 1,
                    condition=((row.get("Condition") or "sealed").strip().lower() or "sealed"),
                    price=_parse_money(row.get("Price")),
                    price_date=_parse_date(row.get("Price date")),
                    source=(row.get("Source") or "").strip(),
                    cost_basis=_parse_money(row.get("Cost basis")),
                    notes=(row.get("Notes") or "").strip(),
                    line=index,
                )
            )
    return holdings


def save_sealed(holdings: Iterable[SealedHolding], path, *, pin_sets: bool = False) -> None:
    """Write `sealed.csv` back out.

    `pin_sets=True` fills the Set column from whatever each row resolved to,
    which turns an ambiguous list into an unambiguous one in a single pass.
    """
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(SEALED_COLUMNS), lineterminator="\r\n")
        writer.writeheader()
        for h in holdings:
            set_value = h.set_hint
            if pin_sets and h.deck is not None:
                set_value = h.deck.set_code
            writer.writerow(
                {
                    "Name": h.raw_name,
                    "Set": set_value,
                    "Quantity": h.quantity,
                    "Condition": h.condition,
                    "Price": "" if h.price is None else f"{cents(h.price):.2f}",
                    "Price date": h.price_date.isoformat() if h.price_date else "",
                    "Source": h.source,
                    "Cost basis": "" if h.cost_basis is None else f"{cents(h.cost_basis):.2f}",
                    "Notes": h.notes,
                }
            )


# --- resolution -------------------------------------------------------------


def _filter_by_set(candidates: Sequence[Deck], set_hint: str) -> List[Deck]:
    if not set_hint:
        return list(candidates)
    wanted = set_hint.strip().lower()
    narrowed = [d for d in candidates if d.set_code.lower() == wanted]
    # A set hint that matches nothing is more likely a typo than a reason to
    # discard every candidate, so fall back rather than silently unmatching.
    return narrowed or list(candidates)


def resolve(
    holdings: Iterable[SealedHolding], catalog: Optional[Catalog] = None
) -> Tuple[List[SealedHolding], List[Issue]]:
    """Pin each row to an exact product, reporting whatever can't be pinned.

    Order: UUID, then exact full name, then nickname. A set hint narrows the
    candidate list at each step. Multiple survivors are reported as ambiguous
    with the candidates attached — picking one would silently misvalue a deck,
    since reprint pairs can differ several-fold in price.
    """
    catalog = catalog if catalog is not None else load_catalog()
    resolved: List[SealedHolding] = []
    issues: List[Issue] = []

    for holding in holdings:
        if not holding.raw_name:
            issues.append(Issue("error", "no-name", "Row has no deck name", holding))
            resolved.append(holding)
            continue

        deck = catalog.by_uuid(holding.raw_name)
        if deck is not None:
            resolved.append(replace(holding, deck=deck, match=MATCH_UUID))
            continue

        # A row may carry doctor's own suggestion, which is formatted
        # `Name [SET]`. Strip that suffix before lookup — only when the code is
        # real, so a name that merely ends in brackets is left alone — and let
        # it stand in as a set hint when the Set column is empty. The explicit
        # column still wins; `_filter_by_set` falls back if either disagrees.
        lookup_name = holding.raw_name
        set_hint = holding.set_hint
        base, display_set = split_display(holding.raw_name)
        if base and display_set and catalog.has_set(display_set):
            lookup_name = base
            set_hint = set_hint or display_set

        # Narrowest match first. Each tier is tried only if the previous found
        # nothing, which is what keeps "Wakanda Forever" resolving to the base
        # deck instead of going ambiguous against its Collector's Edition.
        tiers = (
            (MATCH_EXACT, catalog.by_name),
            (MATCH_NICKNAME, catalog.by_nickname),
            (MATCH_SUFFIX, catalog.by_nickname_suffix),
            (MATCH_CONTAINS, catalog.by_nickname_contains),
        )
        candidates: List[Deck] = []
        match = MATCH_UNMATCHED
        for tier_name, lookup in tiers:
            found = _filter_by_set(lookup(lookup_name), set_hint)
            if found:
                candidates, match = found, tier_name
                break

        if len(candidates) == 1:
            found = candidates[0]
            out = replace(holding, deck=found, match=match)
            resolved.append(out)

            # A Collector's Edition sibling is a real valuation trap: same
            # nickname, several times the price. Worth one informational line.
            siblings = [
                d
                for d in catalog.decks
                if d.set_code == found.set_code
                and d.uuid != found.uuid
                and d.is_collectors_edition
                and nickname(found.name, found.set_name)
                in nickname(d.name, d.set_name)
            ]
            if siblings and not found.is_collectors_edition:
                issues.append(
                    Issue(
                        "info",
                        "collectors-edition-exists",
                        f"{found.name} also exists as a Collector's Edition — "
                        f"confirm which one you own, they price differently",
                        out,
                    )
                )
            continue

        if len(candidates) > 1:
            out = replace(
                holding, match=MATCH_AMBIGUOUS, candidates=tuple(candidates)
            )
            resolved.append(out)
            options = ", ".join(f"{d.set_code} ({d.year})" for d in candidates)
            issues.append(
                Issue(
                    "warn",
                    "ambiguous",
                    f"{holding.raw_name!r} matches {len(candidates)} products — "
                    f"add a Set to pick one: {options}",
                    out,
                )
            )
            continue

        # Nothing matched. Offer the closest names so the fix is one edit.
        near = difflib.get_close_matches(
            nickname(lookup_name),
            [d.nickname for d in catalog.decks],
            n=3,
            cutoff=0.6,
        )
        suggestions = []
        for nick in near:
            suggestions.extend(d.display for d in catalog.by_nickname(nick))
        out = replace(holding, match=MATCH_UNMATCHED)
        resolved.append(out)
        issues.append(
            Issue(
                "error",
                "unmatched",
                f"{holding.raw_name!r} matched no known commander deck"
                + (f" — did you mean: {'; '.join(suggestions[:3])}?" if suggestions else ""),
                out,
            )
        )

    issues.extend(_value_issues(resolved))
    return resolved, issues


def _value_issues(holdings: Sequence[SealedHolding]) -> List[Issue]:
    issues: List[Issue] = []
    for h in holdings:
        if h.quantity <= 0:
            issues.append(
                Issue("error", "bad-quantity", f"Quantity {h.quantity} on {h.display}", h)
            )
        if not h.has_price:
            issues.append(
                Issue("warn", "no-price", f"No price recorded for {h.display}", h)
            )
        elif h.price_date is None:
            # An undated valuation is not usable as insurance documentation.
            issues.append(
                Issue(
                    "warn",
                    "no-price-date",
                    f"{h.display} has a price but no date — undated valuations "
                    f"don't support an insurance claim",
                    h,
                )
            )
        if h.condition not in KNOWN_CONDITIONS:
            issues.append(
                Issue(
                    "warn",
                    "condition",
                    f"{h.display} has condition {h.condition!r}; expected one of "
                    f"{', '.join(KNOWN_CONDITIONS)}",
                    h,
                )
            )
    return issues


# --- summary ----------------------------------------------------------------


@dataclass(frozen=True)
class SealedSummary:
    rows: int
    decks: int
    quantity: int
    total_value: Decimal
    priced_quantity: int
    unpriced_quantity: int
    unresolved_rows: int
    total_cost: Optional[Decimal]
    total_gain: Optional[Decimal]
    oldest_price_date: Optional[date]
    newest_price_date: Optional[date]
    by_year: "Dict[str, Tuple[int, Decimal]]"
    by_set: "Dict[str, Tuple[int, Decimal]]"

    @property
    def fully_priced(self) -> bool:
        return self.unpriced_quantity == 0


def summarize_sealed(holdings: Sequence[SealedHolding]) -> SealedSummary:
    from collections import OrderedDict, defaultdict

    holdings = list(holdings)
    if not holdings:
        empty: Dict[str, Tuple[int, Decimal]] = OrderedDict()
        return SealedSummary(
            0, 0, 0, Decimal("0.00"), 0, 0, 0, None, None, None, None, empty, empty
        )

    priced = [h for h in holdings if h.has_price]
    dates = sorted(h.price_date for h in holdings if h.price_date)
    costs = [h.total_cost for h in holdings if h.total_cost is not None]
    gains = [h.gain for h in holdings if h.gain is not None]

    def rollup(key) -> "Dict[str, Tuple[int, Decimal]]":
        buckets: Dict[str, List[SealedHolding]] = defaultdict(list)
        for h in holdings:
            buckets[key(h) or "—"].append(h)
        ordered = sorted(
            buckets.items(),
            key=lambda kv: sum((h.total_value for h in kv[1]), Decimal("0")),
            reverse=True,
        )
        return OrderedDict(
            (
                name,
                (
                    sum(h.quantity for h in group),
                    cents(sum((h.total_value for h in group), Decimal("0"))),
                ),
            )
            for name, group in ordered
        )

    return SealedSummary(
        rows=len(holdings),
        decks=len({h.identity for h in holdings}),
        quantity=sum(h.quantity for h in holdings),
        total_value=cents(sum((h.total_value for h in holdings), Decimal("0"))),
        priced_quantity=sum(h.quantity for h in priced),
        unpriced_quantity=sum(h.quantity for h in holdings if not h.has_price),
        unresolved_rows=sum(1 for h in holdings if not h.resolved),
        total_cost=cents(sum(costs, Decimal("0"))) if costs else None,
        total_gain=cents(sum(gains, Decimal("0"))) if gains else None,
        oldest_price_date=dates[0] if dates else None,
        newest_price_date=dates[-1] if dates else None,
        by_year=rollup(lambda h: h.year),
        by_set=rollup(lambda h: h.set_code),
    )


# --- diff -------------------------------------------------------------------
#
# Deliberately separate from `diff.py`: that module keys on `Card.identity` and
# routes through `merge()`, which is card-specific. Contorting SealedHolding into
# Card's shape to reuse forty lines would couple two models that have no reason
# to move together.


@dataclass(frozen=True)
class SealedChange:
    before: SealedHolding
    after: SealedHolding

    @property
    def quantity_delta(self) -> int:
        return self.after.quantity - self.before.quantity

    @property
    def price_delta(self) -> Optional[Decimal]:
        if self.before.price is None or self.after.price is None:
            return None
        return self.after.price - self.before.price

    @property
    def value_delta(self) -> Decimal:
        return self.after.total_value - self.before.total_value

    @property
    def pct(self) -> Optional[Decimal]:
        if not self.before.has_price or self.before.total_value == 0:
            return None
        return (self.value_delta / self.before.total_value) * 100

    @property
    def display(self) -> str:
        return self.after.display


@dataclass(frozen=True)
class SealedDiff:
    added: Tuple[SealedHolding, ...]
    removed: Tuple[SealedHolding, ...]
    quantity_changed: Tuple[SealedChange, ...]
    price_changed: Tuple[SealedChange, ...]
    unchanged: Tuple[SealedHolding, ...]

    @property
    def value_delta(self) -> Decimal:
        moved = sum(
            (c.value_delta for c in self.quantity_changed + self.price_changed),
            Decimal("0"),
        )
        added = sum((h.total_value for h in self.added), Decimal("0"))
        removed = sum((h.total_value for h in self.removed), Decimal("0"))
        return cents(added - removed + moved)

    def is_empty(self) -> bool:
        return not (
            self.added or self.removed or self.quantity_changed or self.price_changed
        )


def diff_sealed(
    old: Iterable[SealedHolding], new: Iterable[SealedHolding]
) -> SealedDiff:
    """Compare two snapshots, keyed on MTGJSON UUID.

    A row whose quantity *and* price both moved lands in `quantity_changed`
    only, so nothing is double-counted in `value_delta`.
    """
    before = {h.identity: h for h in old}
    after = {h.identity: h for h in new}

    added = [h for k, h in after.items() if k not in before]
    removed = [h for k, h in before.items() if k not in after]

    qty_changed: List[SealedChange] = []
    price_changed: List[SealedChange] = []
    unchanged: List[SealedHolding] = []

    for key, new_h in after.items():
        old_h = before.get(key)
        if old_h is None:
            continue
        if old_h.quantity != new_h.quantity:
            qty_changed.append(SealedChange(old_h, new_h))
        elif old_h.price != new_h.price:
            price_changed.append(SealedChange(old_h, new_h))
        else:
            unchanged.append(new_h)

    qty_changed.sort(key=lambda c: abs(c.value_delta), reverse=True)
    price_changed.sort(key=lambda c: abs(c.value_delta), reverse=True)

    return SealedDiff(
        added=tuple(sorted(added, key=lambda h: h.total_value, reverse=True)),
        removed=tuple(sorted(removed, key=lambda h: h.total_value, reverse=True)),
        quantity_changed=tuple(qty_changed),
        price_changed=tuple(price_changed),
        unchanged=tuple(unchanged),
    )


def snapshot_path(directory, when: Optional[date] = None) -> str:
    stamp = (when or date.today()).isoformat()
    return os.path.join(os.fspath(directory), f"sealed-{stamp}.csv")
