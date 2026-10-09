"""Parse a TCGplayer seller inventory export (CSV). Pure functions, no I/O:
routes/imports.py resolves the parsed rows against mtg-api and applies them.

Expected columns (TCGplayer's "Export Inventory" from the seller portal):

    TCGplayer Id, Product Line, Set Name, Product Name, Title, Number, Rarity,
    Condition, TCG Market Price, TCG Direct Low, TCG Low Price With Shipping,
    TCG Low Price, Total Quantity, Add to Quantity, TCG Marketplace Price,
    Photo URL

The mapping is tolerant: headers match case- and whitespace-insensitively,
column order doesn't matter, and unknown columns are ignored. Only these are
used:

    Product Line          rows whose value doesn't start with "Magic" are skipped
    Set Name              -> set code, by exact case-insensitive name match
                             against mtg-api /v1/sets
    Number                collector number; "149/249" -> "149", leading zeros
                             dropped ("0149" -> "149")
    Condition             "Near Mint", "Lightly Played Foil", "Near Mint Etched",
                          "Near Mint Foil - Japanese" -> (condition, finish, lang)
    Total Quantity        the on-hand quantity (import *sets* qty to this)
    TCG Marketplace Price the store's listed price -> integer cents via Decimal
                          (optional; blank leaves the POS price untouched)
    Product Name          echoed back in the preview only

"TCGplayer Id" is TCGplayer's SKU id, not the product id mtg-api knows, so it
is not used for matching.
"""

import csv
import io
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

MAX_BYTES = 2_000_000
MAX_ROWS = 2_000

REQUIRED_COLUMNS = ("product line", "set name", "number", "condition", "total quantity")

CONDITIONS = {
    "near mint": "NM",
    "lightly played": "LP",
    "moderately played": "MP",
    "heavily played": "HP",
    "damaged": "DMG",
}
# Longest first so "chinese simplified" wins over a shorter overlap.
LANGUAGES = {
    "chinese simplified": "zhs",
    "simplified chinese": "zhs",
    "chinese traditional": "zht",
    "traditional chinese": "zht",
    "portuguese": "pt",
    "japanese": "ja",
    "english": "en",
    "italian": "it",
    "spanish": "es",
    "russian": "ru",
    "german": "de",
    "french": "fr",
    "korean": "ko",
}


class CsvError(ValueError):
    """A whole-file problem (bad encoding, missing columns, too many rows)."""


def norm_header(name: str) -> str:
    return " ".join(name.replace("﻿", "").strip().lower().split())


def _remove_phrase(text: str, phrase: str) -> tuple[str, bool]:
    new = re.sub(rf"(^| ){re.escape(phrase)}( |$)", " ", text)
    return " ".join(new.split()), new != text


def parse_condition(value: str) -> tuple[str, str, str]:
    """TCGplayer condition text -> (condition, finish, lang). Raises
    ValueError on anything it doesn't recognise rather than guessing."""
    text = " ".join(re.sub(r"[-–—,()]", " ", value.lower()).split())
    lang = "en"
    for name, code in LANGUAGES.items():
        text, found = _remove_phrase(text, name)
        if found:
            lang = code
            break
    finish = "nonfoil"
    text, etched = _remove_phrase(text, "etched")
    if etched:
        finish = "etched"
        text, _ = _remove_phrase(text, "foil")
    else:
        text, non_foil = _remove_phrase(text, "non foil")
        text, nonfoil = _remove_phrase(text, "nonfoil")
        text, foil = _remove_phrase(text, "foil")
        if foil and not (non_foil or nonfoil):
            finish = "foil"
    if text not in CONDITIONS:
        raise ValueError(f"unrecognised condition {value!r}")
    return CONDITIONS[text], finish, lang


def parse_cents(value: str) -> int | None:
    """"$1,234.56" -> 123456 via Decimal (half-up to the cent). Blank -> None."""
    text = value.strip().replace("$", "").replace(",", "")
    if not text:
        return None
    try:
        amount = Decimal(text)
    except InvalidOperation:
        raise ValueError(f"bad price {value!r}") from None
    if not amount.is_finite() or amount < 0:
        raise ValueError(f"bad price {value!r}")
    cents = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if cents > 2**31 - 1:
        raise ValueError(f"price too large {value!r}")
    return cents


def parse_qty(value: str) -> int:
    text = value.strip()
    if not re.fullmatch(r"\d{1,9}", text):
        raise ValueError(f"bad quantity {value!r}")
    return int(text)


def normalise_number(value: str) -> str:
    number = value.strip().split("/")[0].strip()
    stripped = number.lstrip("0")
    return stripped if stripped else number


def parse_csv(data: bytes) -> list[dict[str, Any]]:
    """Rows as dicts: {"row" (1-based line number), "status" ("parsed" |
    "skipped" | "unmatched"), "reason", "product_name", "set_name", "number",
    "condition", "finish", "lang", "qty", "price_cents"}. Raises CsvError
    for whole-file problems."""
    if len(data) > MAX_BYTES:
        raise CsvError(f"file is larger than {MAX_BYTES} bytes")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CsvError("file is not UTF-8 text") from None
    if "\x00" in text:
        raise CsvError("file contains NUL bytes")
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(reader)
    except StopIteration:
        raise CsvError("file is empty") from None
    columns = {norm_header(h): i for i, h in enumerate(header)}
    missing = [c for c in REQUIRED_COLUMNS if c not in columns]
    if missing:
        raise CsvError(f"missing column(s): {', '.join(missing)}")

    def cell(record: list[str], name: str) -> str:
        i = columns.get(name)
        return record[i].strip() if i is not None and i < len(record) else ""

    rows = []
    for record in reader:
        if not any(v.strip() for v in record):
            continue
        if len(rows) >= MAX_ROWS:
            raise CsvError(f"more than {MAX_ROWS} rows; split the file")
        row: dict[str, Any] = {
            "row": reader.line_num,
            "status": "parsed",
            "reason": None,
            "product_name": cell(record, "product name")[:300] or None,
            "set_name": cell(record, "set name")[:300] or None,
            "number": None,
            "condition": None,
            "finish": None,
            "lang": None,
            "qty": None,
            "price_cents": None,
        }
        rows.append(row)
        line = cell(record, "product line")
        if not line.lower().startswith("magic"):
            row.update(status="skipped", reason=f"product line {line!r} is not Magic")
            continue
        try:
            row["condition"], row["finish"], row["lang"] = parse_condition(
                cell(record, "condition")
            )
            row["qty"] = parse_qty(cell(record, "total quantity"))
            row["price_cents"] = parse_cents(cell(record, "tcg marketplace price"))
        except ValueError as err:
            row.update(status="unmatched", reason=str(err))
            continue
        row["number"] = normalise_number(cell(record, "number"))[:50] or None
        if not row["set_name"] or not row["number"]:
            row.update(status="unmatched", reason="set name and number are required")
    return rows
