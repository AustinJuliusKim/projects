"""Exporters — buylist CSV, vault markdown tables, and the tracking ledger."""

from __future__ import annotations

import csv
from datetime import date
from decimal import Decimal
from typing import Iterable, List, Optional, Sequence

from .aggregate import CK_TIERS, cents, merge, multi_copies, price_tiers
from .io import save as _save
from .model import Card, Collection, money

__all__ = [
    "BUYLIST_COLUMNS",
    "LEDGER_COLUMNS",
    "to_manabox_csv",
    "to_buylist_csv",
    "to_ledger_csv",
    "to_sealed_ledger_csv",
    "to_markdown",
    "tier_table",
    "multi_copy_table",
    "top_table",
    "CK_SUBMISSION_COLUMNS",
]


BUYLIST_COLUMNS = (
    "Name",
    "Set name",
    "Set code",
    "Collector number",
    "Foil",
    "Quantity",
    "Market each",
    "Market total",
    "Est. cash",
    "Est. credit",
    "Language",
    "Condition",
)

# Card Kingdom's CSV importer accepts exactly these four columns and rejects a
# file with more. "Edition" is their word for the set *name* — not the set
# code that this package's `edition` field carries.
CK_SUBMISSION_COLUMNS = (
    "Card Name",
    "Edition",
    "Foil",
    "Quantity",
)

# Schema from ObsidianVault 30-projects/Financial Freedom Profile.md — Moxfield's
# export extended with the tax and insurance columns.
LEDGER_COLUMNS = (
    "Name",
    "Set name",
    "Set code",
    "Collector number",
    "Foil",
    "Quantity",
    "Condition",
    "Language",
    "Scryfall ID",
    "Acquisition Date",
    "Source",
    "Cost Basis",
    "Market Value",
    "Valuation Date",
    "Sold",
    "Fees",
    "Net Proceeds",
    "Realized Gain/Loss",
    "Insurance Flag",
    "Photo Ref",
    "Notes",
)


def to_manabox_csv(cards: Iterable[Card], path, **kwargs) -> None:
    """Write a ManaBox-importable CSV (see `io.save`)."""
    _save(cards, path, **kwargs)


def _rates_for(price: Decimal, tiers: Sequence = CK_TIERS):
    for tier in sorted(tiers, key=lambda t: t.floor, reverse=True):
        if tier.contains(price):
            return tier.cash_rate, tier.credit_rate
    return Decimal("0"), Decimal("0")


def to_buylist_csv(
    cards: Iterable[Card],
    path,
    *,
    min_price=Decimal("1"),
    tiers: Sequence = CK_TIERS,
    already_merged: bool = False,
) -> Collection:
    """Write a vendor submission list, most valuable stack first.

    Defaults to dropping sub-$1 cards: vendor buylists pay close to nothing for
    them and they inflate the shipment. Pass `min_price=0` to keep everything.

    Returns the rows written, so callers can report on what went out.
    """
    pool = cards if already_merged else merge(cards)
    limit = money(min_price)
    rows = [card for card in pool if card.market_price >= limit]
    rows.sort(key=lambda c: c.total_value, reverse=True)

    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(BUYLIST_COLUMNS), lineterminator="\r\n")
        writer.writeheader()
        for card in rows:
            cash_rate, credit_rate = _rates_for(card.market_price, tiers)
            writer.writerow(
                {
                    "Name": card.title,
                    "Set name": card.set_name,
                    "Set code": card.edition,
                    "Collector number": card.collector_number,
                    "Foil": "foil" if card.foil else "",
                    "Quantity": card.quantity,
                    "Market each": cents(card.market_price),
                    "Market total": cents(card.total_value),
                    "Est. cash": cents(card.total_value * cash_rate),
                    "Est. credit": cents(card.total_value * credit_rate),
                    "Language": card.language,
                    "Condition": card.condition,
                }
            )
    return Collection(rows)


def to_ledger_csv(
    cards: Iterable[Card],
    path,
    *,
    valuation_date: Optional[date] = None,
    insurance_threshold=Decimal("50"),
    already_merged: bool = False,
) -> Collection:
    """Write the master tracking ledger.

    Market Value and Valuation Date are filled in; the tax columns (Cost Basis,
    Sold, Fees, Net Proceeds, Realized Gain/Loss) are left blank on purpose —
    the vault's plan is a batch-level good-faith reconstruction from order
    history, which is not something this file can guess.

    `Source` is prefilled with the binder the card was scanned from, which is
    also the closest thing to an acquisition record that exists today.
    """
    pool = cards if already_merged else merge(cards)
    rows = sorted(pool, key=lambda c: c.total_value, reverse=True)
    stamp = (valuation_date or date.today()).isoformat()
    flag_at = money(insurance_threshold)

    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(LEDGER_COLUMNS), lineterminator="\r\n")
        writer.writeheader()
        for card in rows:
            writer.writerow(
                {
                    "Name": card.title,
                    "Set name": card.set_name,
                    "Set code": card.edition,
                    "Collector number": card.collector_number,
                    "Foil": "foil" if card.foil else "",
                    "Quantity": card.quantity,
                    "Condition": card.condition,
                    "Language": card.language,
                    "Scryfall ID": card.scryfall_id,
                    "Acquisition Date": "",
                    "Source": "|".join(card.sources),
                    "Cost Basis": "",
                    "Market Value": cents(card.total_value),
                    "Valuation Date": stamp,
                    "Sold": "",
                    "Fees": "",
                    "Net Proceeds": "",
                    "Realized Gain/Loss": "",
                    "Insurance Flag": "Y" if card.total_value >= flag_at else "",
                    "Photo Ref": "",
                    "Notes": "",
                }
            )
    return Collection(rows)


# --- markdown ---------------------------------------------------------------


def to_sealed_ledger_csv(
    holdings: Iterable,
    path,
    *,
    valuation_date: Optional[date] = None,
    insurance_threshold=Decimal("50"),
) -> list:
    """Write sealed holdings into the same ledger schema as the singles.

    Same columns as `to_ledger_csv` so both piles land in one
    `mtg_collection_tracker.csv`. Differences that matter:

    - `Valuation Date` comes from each row's own `Price date` where present,
      because a hand-entered sealed price was looked up on a specific day and
      claiming today's date for it would be false.
    - `Cost Basis` is carried through when the row has one, rather than always
      blank — sealed decks were often bought at a known MSRP.
    """
    rows = sorted(holdings, key=lambda h: h.total_value, reverse=True)
    fallback = (valuation_date or date.today()).isoformat()
    flag_at = money(insurance_threshold)

    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(LEDGER_COLUMNS), lineterminator="\r\n")
        writer.writeheader()
        for h in rows:
            deck = h.deck
            writer.writerow(
                {
                    "Name": deck.name if deck else h.raw_name,
                    "Set name": deck.set_name if deck else "",
                    "Set code": h.set_code,
                    "Collector number": "",
                    "Foil": "",
                    "Quantity": h.quantity,
                    "Condition": h.condition,
                    "Language": "en",
                    "Scryfall ID": "",
                    "Acquisition Date": "",
                    "Source": "sealed",
                    "Cost Basis": "" if h.cost_basis is None else cents(h.total_cost),
                    "Market Value": "" if not h.has_price else cents(h.total_value),
                    "Valuation Date": h.price_date.isoformat() if h.price_date else fallback,
                    "Sold": "",
                    "Fees": "",
                    "Net Proceeds": "",
                    "Realized Gain/Loss": "",
                    "Insurance Flag": "Y" if h.total_value >= flag_at else "",
                    "Photo Ref": "",
                    "Notes": " · ".join(
                        p for p in (f"MTGJSON {deck.uuid}" if deck else "", h.notes) if p
                    ),
                }
            )
    return rows


def to_markdown(rows: Iterable[Sequence], headers: Sequence[str]) -> str:
    """Render a GitHub-flavored pipe table, matching the vault's style."""
    body = [[str(cell) for cell in row] for row in rows]
    header = list(headers)
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for row in body:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _dollars(value: Decimal) -> str:
    return f"${cents(value):,.2f}"


def _dollars_round(value: Decimal) -> str:
    return f"${cents(value):,.0f}"


def tier_table(cards: Iterable[Card], tiers: Sequence = CK_TIERS) -> str:
    """The vault's CK Buylist Estimates table, regenerated from live data."""
    rows_by_tier = price_tiers(cards, tiers)
    rows: List[Sequence] = []
    total_qty = 0
    total_value = Decimal("0")
    total_cash = Decimal("0")
    total_credit = Decimal("0")

    for row in rows_by_tier.values():
        cash_pct = int(row.tier.cash_rate * 100)
        credit_pct = int(row.tier.credit_rate * 100)
        rows.append(
            [
                row.label,
                f"{row.quantity} cards",
                _dollars_round(row.market_value),
                f"~{_dollars_round(row.cash)} ({cash_pct}%)",
                f"~{_dollars_round(row.credit)} ({credit_pct}%)",
            ]
        )
        total_qty += row.quantity
        total_value += row.market_value
        total_cash += row.cash
        total_credit += row.credit

    rows.append(
        [
            "**Total**",
            f"**{total_qty} cards**",
            f"**{_dollars_round(total_value)}**",
            f"**~{_dollars_round(total_cash)}**",
            f"**~{_dollars_round(total_credit)}**",
        ]
    )
    return to_markdown(rows, ["Tier", "Cards", "Market Value", "Cash Est.", "Credit Est."])


def multi_copy_table(cards: Iterable[Card], min_qty: int = 4, limit: int = 20) -> str:
    """The vault's Multi-Copy Flags table."""
    stacks = multi_copies(cards, min_qty=min_qty)[:limit]
    rows = [
        [
            card.display_name,
            f"×{card.quantity}",
            _dollars_round(card.market_price),
            _dollars_round(card.total_value),
        ]
        for card in stacks
    ]
    return to_markdown(rows, ["Card", "Qty", "Each", "Total"])


def top_table(cards: Iterable[Card], n: int = 20) -> str:
    """Highest-value positions, for the plan doc or a quick sanity read."""
    ranked = sorted(cards, key=lambda c: c.total_value, reverse=True)[:n]
    rows = [
        [
            card.display_name,
            card.edition,
            f"×{card.quantity}",
            _dollars(card.market_price),
            _dollars(card.total_value),
        ]
        for card in ranked
    ]
    return to_markdown(rows, ["Card", "Set", "Qty", "Each", "Total"])
