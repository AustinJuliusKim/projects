"""Utilities for ManaBox binder CSV exports.

Typical use::

    from binders import load_many, merge, price_tiers, multi_copies

    cards = load_many("Binders.csv", "Binders2.csv")
    collection = merge(cards)

    print(price_tiers(collection)["prime"].market_value)
    for card in multi_copies(collection, min_qty=4):
        print(card.display_name, card.quantity)

Or from the command line::

    python3 -m binders tiers Binders.csv Binders2.csv --markdown
"""

from __future__ import annotations

from .aggregate import (
    CK_TIERS,
    Summary,
    TierRow,
    cents,
    group_by,
    high_value,
    merge,
    multi_copies,
    price_tiers,
    summarize,
    top_n,
)
from .catalog import Catalog, Deck, load_catalog
from .dashboard import build_dashboard, build_payload, render_html
from .diff import Change, Diff, diff
from .export import (
    to_buylist_csv,
    to_ledger_csv,
    to_manabox_csv,
    to_markdown,
    multi_copy_table,
    tier_table,
    top_table,
)
from .filters import all_of, any_of, negate, where
from .io import Issue, load, load_many, save, validate
from .sealed import (
    SealedHolding,
    diff_sealed,
    load_sealed,
    resolve,
    save_sealed,
    summarize_sealed,
)
from .sealed_dashboard import (
    build_sealed_dashboard,
    build_sealed_payload,
    render_sealed_html,
)
from .model import Card, Collection, Tier, money, normalize_title

__version__ = "0.1.0"

__all__ = [
    # model
    "Card",
    "Collection",
    "Tier",
    "money",
    "normalize_title",
    # io
    "load",
    "load_many",
    "save",
    "validate",
    "Issue",
    # filters
    "where",
    "all_of",
    "any_of",
    "negate",
    # aggregate
    "merge",
    "group_by",
    "summarize",
    "price_tiers",
    "multi_copies",
    "high_value",
    "top_n",
    "cents",
    "CK_TIERS",
    "Summary",
    "TierRow",
    # diff
    "diff",
    "Diff",
    "Change",
    # dashboard
    "build_dashboard",
    "build_payload",
    "render_html",
    # sealed
    "Catalog",
    "Deck",
    "load_catalog",
    "SealedHolding",
    "load_sealed",
    "save_sealed",
    "resolve",
    "summarize_sealed",
    "diff_sealed",
    "build_sealed_dashboard",
    "build_sealed_payload",
    "render_sealed_html",
    # export
    "to_manabox_csv",
    "to_buylist_csv",
    "to_ledger_csv",
    "to_markdown",
    "tier_table",
    "multi_copy_table",
    "top_table",
]
