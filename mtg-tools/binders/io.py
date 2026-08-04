"""Reading and writing ManaBox CSV exports.

Round-trip fidelity is a hard requirement: a file that goes `load()` ->
`save()` must still import cleanly back into ManaBox, which means the exact
16-column header in the exact original order, the same boolean spelling, and
the same timestamp precision.
"""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Iterable, List, Optional, Sequence

from .model import Card, Collection, money, normalize_title

__all__ = [
    "MANABOX_COLUMNS",
    "COLUMN_ALIASES",
    "SOURCE_COLUMN",
    "Issue",
    "UnknownSchema",
    "load",
    "load_many",
    "save",
    "validate",
    "parse_row",
    "to_row",
    "canonical_header",
]

# The header ManaBox writes, in order. Do not reorder.
MANABOX_COLUMNS = (
    "Title",
    "Edition",
    "Foil",
    "Quantity",
    "Set name",
    "Collector number",
    "Rarity",
    "ManaBox ID",
    "Scryfall ID",
    "Purchase price",
    "Misprint",
    "Altered",
    "Condition",
    "Language",
    "Purchase price currency",
    "Added",
)

SOURCE_COLUMN = "Source"

# ManaBox has shipped at least two header dialects. The older one — still on
# disk in the .bak exports — names the first two columns differently and orders
# the columns differently:
#
#   Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,...
#   Title,Edition,Foil,Quantity,Set name,Collector number,Rarity,...
#
# Column order does not matter (rows are read by name), but the names do.
# Without these aliases the old dialect parses into rows with empty titles,
# which is worse than an error because it looks like it worked.
COLUMN_ALIASES = {
    "name": "Title",
    "card name": "Title",
    "set code": "Edition",
    "set": "Edition",
    "purchase price currency": "Purchase price currency",
    "currency": "Purchase price currency",
    "scryfall id": "Scryfall ID",
    "manabox id": "ManaBox ID",
}

_TRUE = {"true", "1", "yes", "y", "t"}
_FALSE = {"false", "0", "no", "n", "f", ""}

# ManaBox has shipped the Foil column both ways across export versions.
_FINISH_WORDS = {"normal", "nonfoil", "non-foil", "foil", "etched", "etched foil"}


def _parse_bool(value: Optional[str]) -> bool:
    text = (value or "").strip().casefold()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    raise ValueError(f"cannot interpret {value!r} as a boolean")


def _parse_finish(value: Optional[str]) -> tuple:
    """Return (is_foil, finish_word).

    `finish_word` is "" when the source used the numeric 0/1 dialect, so
    `to_row` can write the file back in whichever dialect it came in.
    """
    text = (value or "").strip().casefold()
    if text in _FINISH_WORDS:
        if text in {"normal", "nonfoil", "non-foil"}:
            return False, "normal"
        if text.startswith("etched"):
            return True, "etched"
        return True, "foil"
    return _parse_bool(text), ""


def _parse_added(value: Optional[str]) -> Optional[datetime]:
    text = (value or "").strip()
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        # Fall back to a date-only value rather than losing the row.
        try:
            return datetime.fromisoformat(text[:10])
        except ValueError:
            return None


def _format_added(value: Optional[datetime]) -> str:
    """Render back in ManaBox's format: millisecond precision, trailing Z."""
    if value is None:
        return ""
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _format_price(value: Decimal) -> str:
    # Decimal preserves the scale it was parsed with, so "1.10" stays "1.10".
    return str(value)


class UnknownSchema(ValueError):
    """A CSV whose header has no column this package recognizes as a card name."""


def canonical_header(fieldnames: Iterable[str]) -> dict:
    """Map a file's actual header to canonical column names.

    Returns {actual_name: canonical_name}. Unrecognized columns map to
    themselves and end up in `Card.extra`.
    """
    mapping = {}
    canonical_lookup = {c.casefold(): c for c in MANABOX_COLUMNS}
    for name in fieldnames or ():
        if not name:
            continue
        key = name.strip().casefold()
        if key in canonical_lookup:
            mapping[name] = canonical_lookup[key]
        elif key in COLUMN_ALIASES:
            mapping[name] = COLUMN_ALIASES[key]
        else:
            mapping[name] = name
    return mapping


def _canonicalize(row: dict) -> dict:
    return {canonical: row[actual] for actual, canonical in canonical_header(row).items()}


def parse_row(row: dict, source: Optional[str] = None) -> Card:
    """Turn one CSV row (a dict from DictReader) into a `Card`.

    Accepts either header dialect; see `COLUMN_ALIASES`.
    """
    row = _canonicalize(row)
    known = {c.casefold() for c in MANABOX_COLUMNS} | {SOURCE_COLUMN.casefold()}
    extra = {
        key: value
        for key, value in row.items()
        if key and key.casefold() not in known and value not in (None, "")
    }

    foil, finish = _parse_finish(row.get("Foil"))

    try:
        price = money(row.get("Purchase price"))
    except (InvalidOperation, ValueError):
        price = Decimal("0")

    quantity_raw = (row.get("Quantity") or "1").strip()
    quantity = int(quantity_raw) if quantity_raw.lstrip("-").isdigit() else 1

    sources = ()
    if source:
        sources = (source,)
    elif row.get(SOURCE_COLUMN):
        sources = tuple(
            part.strip() for part in row[SOURCE_COLUMN].split("|") if part.strip()
        )

    return Card(
        title=(row.get("Title") or "").strip(),
        edition=(row.get("Edition") or "").strip(),
        foil=foil,
        quantity=quantity,
        set_name=(row.get("Set name") or "").strip(),
        collector_number=(row.get("Collector number") or "").strip(),
        rarity=(row.get("Rarity") or "").strip().casefold(),
        manabox_id=(row.get("ManaBox ID") or "").strip(),
        scryfall_id=(row.get("Scryfall ID") or "").strip(),
        market_price=price,
        misprint=_parse_bool(row.get("Misprint")),
        altered=_parse_bool(row.get("Altered")),
        condition=(row.get("Condition") or "").strip(),
        language=(row.get("Language") or "").strip(),
        currency=(row.get("Purchase price currency") or "").strip(),
        added=_parse_added(row.get("Added")),
        sources=sources,
        finish=finish,
        extra=extra,
    )


def to_row(card: Card, *, include_sources: bool = False) -> dict:
    """Turn a `Card` back into a CSV row dict."""
    if card.finish:
        foil_text = card.finish
    else:
        foil_text = "1" if card.foil else "0"

    row = {
        "Title": card.title,
        "Edition": card.edition,
        "Foil": foil_text,
        "Quantity": str(card.quantity),
        "Set name": card.set_name,
        "Collector number": card.collector_number,
        "Rarity": card.rarity,
        "ManaBox ID": card.manabox_id,
        "Scryfall ID": card.scryfall_id,
        "Purchase price": _format_price(card.market_price),
        "Misprint": "true" if card.misprint else "false",
        "Altered": "true" if card.altered else "false",
        "Condition": card.condition,
        "Language": card.language,
        "Purchase price currency": card.currency,
        "Added": _format_added(card.added),
    }
    row.update(card.extra)
    if include_sources:
        row[SOURCE_COLUMN] = "|".join(card.sources)
    return row


def load(path, source: Optional[str] = None) -> Collection:
    """Load one export. Rows are tagged with `source` (default: filename stem).

    Both ManaBox header dialects are accepted. A header with no recognizable
    card-name column raises `UnknownSchema` rather than yielding rows with
    empty titles — a silently blank collection is far more dangerous than a
    loud failure when the output feeds a buylist.
    """
    path = os.fspath(path)
    if source is None:
        source = os.path.splitext(os.path.basename(path))[0]
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        mapping = canonical_header(reader.fieldnames)
        if "Title" not in mapping.values():
            found = ", ".join(reader.fieldnames or []) or "(empty file)"
            raise UnknownSchema(
                f"{path}: no card-name column found. Expected one of "
                f"'Title' or 'Name'; header was: {found}"
            )
        return Collection(
            parse_row(row, source=source) for row in reader if any(row.values())
        )


def load_many(*paths) -> Collection:
    """Load several exports into one collection, each row source-tagged.

    Rows are *not* merged — call `aggregate.merge()` for that.
    """
    cards: List[Card] = []
    for path in paths:
        cards.extend(load(path))
    return Collection(cards)


def save(
    cards: Iterable[Card],
    path,
    *,
    include_sources: bool = False,
    columns: Optional[Sequence[str]] = None,
) -> None:
    """Write a ManaBox-importable CSV.

    Extra columns found at load time are appended after the standard 16 so the
    file stays valid for re-import while nothing is silently dropped.
    """
    cards = list(cards)
    if columns is None:
        fieldnames = list(MANABOX_COLUMNS)
        for card in cards:
            for key in card.extra:
                if key not in fieldnames:
                    fieldnames.append(key)
        if include_sources:
            fieldnames.append(SOURCE_COLUMN)
    else:
        fieldnames = list(columns)

    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=fieldnames, extrasaction="ignore", lineterminator="\r\n"
        )
        writer.writeheader()
        for card in cards:
            writer.writerow(to_row(card, include_sources=include_sources))


# --- validation -------------------------------------------------------------


@dataclass(frozen=True)
class Issue:
    """One problem worth a human look before a buylist submission."""

    level: str  # "error" | "warn"
    code: str
    message: str
    card: Optional[Card] = None

    def __str__(self) -> str:
        where = f" [{self.card.display_name}]" if self.card else ""
        return f"{self.level.upper()}: {self.message}{where}"


def validate(cards: Iterable[Card]) -> List[Issue]:
    """Check a collection for things that bite during a buylist submission."""
    cards = list(cards)
    issues: List[Issue] = []
    seen: dict = {}

    for card in cards:
        if not card.title:
            issues.append(
                Issue(
                    "error",
                    "no-title",
                    f"Row with no card name (Scryfall ID {card.scryfall_id or 'also missing'})",
                    card,
                )
            )
        if card.market_price <= 0:
            issues.append(
                Issue("warn", "zero-price", f"No market price on {card.display_name}", card)
            )
        if not card.scryfall_id:
            issues.append(
                Issue(
                    "warn",
                    "no-scryfall-id",
                    f"Missing Scryfall ID on {card.display_name} — merge falls back to name matching",
                    card,
                )
            )
        if card.quantity <= 0:
            issues.append(
                Issue("error", "bad-quantity", f"Quantity {card.quantity} on {card.display_name}", card)
            )
        if card.condition and card.condition != "near_mint":
            issues.append(
                Issue(
                    "warn",
                    "condition",
                    f"{card.display_name} is {card.condition} — buylist pays less than NM",
                    card,
                )
            )
        if card.language and card.language != "en":
            issues.append(
                Issue(
                    "warn",
                    "language",
                    f"{card.display_name} is {card.language} — vendors price "
                    f"non-English differently (${card.total_value:.2f} at market)",
                    card,
                )
            )
        if card.currency and card.currency != "USD":
            issues.append(
                Issue("warn", "currency", f"{card.display_name} priced in {card.currency}", card)
            )
        if card.misprint or card.altered:
            issues.append(
                Issue(
                    "warn",
                    "misprint-altered",
                    f"{card.display_name} flagged misprint/altered — needs manual pricing",
                    card,
                )
            )

        key = (card.sources, card.identity)
        if key in seen:
            issues.append(
                Issue(
                    "warn",
                    "duplicate-row",
                    f"{card.display_name} appears more than once within the same file "
                    f"— quantities should probably be combined",
                    card,
                )
            )
        seen[key] = card

    return issues
