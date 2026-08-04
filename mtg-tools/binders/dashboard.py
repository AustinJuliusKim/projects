"""Build a self-contained HTML triage dashboard from a collection.

The page exists to answer one question card by card: keep it or sell it. The
charts are there to show where the value actually sits — 27 of 410 rows carry
half of it — so the decision starts in the right place.

Two rules shape this module:

1. **Money is computed here, not in the browser.** Every aggregate comes from
   the `Decimal` code in `aggregate`, serialized as a formatted string. The
   page renders those strings verbatim.
2. **Per-card prices cross as integer cents.** The one figure the page must
   compute live is the running total of whatever is marked Sell. Integer cents
   keep that sum exact; float dollars would reintroduce the drift `Decimal`
   exists to prevent.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Sequence

from .aggregate import CK_TIERS, cents, group_by, high_value, merge, multi_copies, summarize
from .aggregate import price_tiers as _price_tiers
from .io import validate
from .model import Card, Collection, money

__all__ = [
    "ASSETS_DIR",
    "MULTI_COPY_MIN",
    "REVIEW_THRESHOLD",
    "TOP_SETS",
    "build_payload",
    "render_html",
    "to_cents",
]

ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

#: Quantity at which a stack is worth a second look before submitting.
MULTI_COPY_MIN = 4

#: Price above which condition should be checked by hand (vault Phase A).
REVIEW_THRESHOLD = Decimal("10")

#: 152 distinct sets is unchartable; the tail becomes one "Other" bar.
TOP_SETS = 15


def to_cents(value) -> int:
    """Exact Decimal dollars -> integer cents. No float anywhere in the path."""
    return int(money(value).quantize(Decimal("0.01")) * 100)


def _dollars(value) -> str:
    return f"${cents(value):,.2f}"


def _card_id(card: Card) -> str:
    """Stable key for a card across regenerations.

    Verdicts are stored against this in the browser, so it must not change when
    another binder is scanned and merged in. `Card.identity` is already built
    for exactly that and falls back to name/set when a Scryfall ID is missing.
    """
    return "|".join(card.identity)


def _build_flags(cards: Sequence[Card]) -> Dict[str, List[str]]:
    """Per-card flags, reusing the existing flag logic rather than restating it."""
    flags: Dict[str, List[str]] = {}

    def add(card: Card, flag: str) -> None:
        key = _card_id(card)
        bucket = flags.setdefault(key, [])
        if flag not in bucket:
            bucket.append(flag)

    for card in multi_copies(cards, min_qty=MULTI_COPY_MIN, already_merged=True):
        add(card, "multi")
    for card in high_value(cards, threshold=REVIEW_THRESHOLD):
        add(card, "review")
    for issue in validate(cards):
        if issue.card is not None and issue.code != "duplicate-row":
            add(issue.card, issue.code)

    return flags


#: Human-readable text for each flag, shown as a tooltip on the page.
FLAG_LABELS = {
    "multi": f"{MULTI_COPY_MIN}+ copies — review before submitting",
    "review": f"${REVIEW_THRESHOLD}+ — check condition by hand",
    "language": "Non-English — vendors price these differently",
    "condition": "Not near mint — buylist pays less",
    "zero-price": "No market price recorded",
    "no-scryfall-id": "No Scryfall ID — matched by name",
    "misprint-altered": "Misprint or altered — needs manual pricing",
    "currency": "Priced in a non-USD currency",
    "no-title": "Row has no card name",
    "bad-quantity": "Invalid quantity",
}


def build_payload(
    cards: Iterable[Card],
    *,
    sources: Optional[Sequence[str]] = None,
    raw: Optional[Iterable[Card]] = None,
    generated_at: Optional[datetime] = None,
    tiers: Sequence = CK_TIERS,
) -> dict:
    """Assemble everything the page needs.

    `cards` should already be merged. Pass `raw` (the unmerged rows) to get
    honest per-binder figures: on merged data a card owned in two binders
    belongs to both sources, so its summed quantity would be counted twice —
    the same trap already handled in `cli.cmd_summary`.
    """
    collection = cards if isinstance(cards, Collection) else Collection(cards)
    ordered = sorted(collection, key=lambda c: (c.total_value, c.quantity), reverse=True)
    flags = _build_flags(ordered)

    total_value = collection.total_value
    total_cents = sum(to_cents(c.market_price) * c.quantity for c in ordered)

    card_rows = [
        {
            "id": _card_id(card),
            "name": card.title,
            "display": card.display_name,
            "setName": card.set_name,
            "setCode": card.edition,
            "number": card.collector_number,
            "rarity": card.rarity,
            "foil": card.foil,
            "qty": card.quantity,
            "cents": to_cents(card.market_price),
            "totalCents": to_cents(card.market_price) * card.quantity,
            "tier": card.tier,
            "sources": list(card.sources),
            "language": card.language,
            "condition": card.condition,
            "flags": flags.get(_card_id(card), []),
        }
        for card in ordered
    ]

    return {
        "meta": {
            "generatedAt": (generated_at or datetime.now(timezone.utc)).isoformat(
                timespec="seconds"
            ),
            "files": list(sources or []),
            "rows": len(ordered),
            "quantity": collection.total_quantity,
            "totalCents": total_cents,
            "totalValue": _dollars(total_value),
            "distinctSets": len(group_by(ordered, "set_name")) if ordered else 0,
        },
        "rates": [
            {
                "tier": tier.name,
                "label": tier.label,
                "cash": str(tier.cash_rate),
                "credit": str(tier.credit_rate),
            }
            for tier in tiers
        ],
        "flagLabels": FLAG_LABELS,
        "cards": card_rows,
        "tiers": _tier_rows(ordered, tiers),
        "concentration": _concentration(ordered, total_value),
        "sets": _set_rows(ordered),
        "sources": _source_rows(raw if raw is not None else ordered),
        "summary": _summary_rows(ordered),
    }


def _tier_rows(cards: Sequence[Card], tiers: Sequence) -> List[dict]:
    rows = []
    for row in _price_tiers(cards, tiers).values():
        rows.append(
            {
                "tier": row.tier.name,
                "label": row.label,
                "qty": row.quantity,
                "marketCents": to_cents(row.market_value),
                "cashCents": to_cents(row.cash),
                "creditCents": to_cents(row.credit),
                "market": _dollars(row.market_value),
                "cash": _dollars(row.cash),
                "credit": _dollars(row.credit),
                "cashPct": int(row.tier.cash_rate * 100),
                "creditPct": int(row.tier.credit_rate * 100),
            }
        )
    return rows


def _concentration(cards: Sequence[Card], total: Decimal) -> dict:
    """Cumulative value curve, plus where the 50/80/90% lines are crossed.

    This is the chart that reframes the project: the sell decision is about a
    hundred cards, not five hundred.
    """
    if not cards or total <= 0:
        return {"points": [], "marks": []}

    points = []
    marks = []
    wanted = [Decimal("0.5"), Decimal("0.8"), Decimal("0.9")]
    running = Decimal("0")
    next_mark = 0

    for index, card in enumerate(cards, start=1):
        running += card.total_value
        fraction = running / total
        points.append(
            {
                "n": index,
                "rowPct": round(float(index / len(cards) * 100), 3),
                "valuePct": round(float(fraction * 100), 3),
            }
        )
        while next_mark < len(wanted) and fraction >= wanted[next_mark]:
            marks.append(
                {
                    "valuePct": int(wanted[next_mark] * 100),
                    "rows": index,
                    "rowPct": round(float(index / len(cards) * 100), 1),
                }
            )
            next_mark += 1

    return {"points": points, "marks": marks}


def _set_rows(cards: Sequence[Card]) -> List[dict]:
    groups = list(group_by(cards, "set_name").items())
    rows = [
        {
            "name": name,
            "qty": group.total_quantity,
            "cents": to_cents(group.total_value),
            "value": _dollars(group.total_value),
        }
        for name, group in groups[:TOP_SETS]
    ]

    tail = groups[TOP_SETS:]
    if tail:
        qty = sum(g.total_quantity for g in (group for _, group in tail))
        value = sum((g.total_value for _, g in tail), Decimal("0"))
        rows.append(
            {
                "name": f"Other ({len(tail)} sets)",
                "qty": qty,
                "cents": to_cents(value),
                "value": _dollars(value),
                "isOther": True,
            }
        )
    return rows


def _source_rows(cards: Iterable[Card]) -> List[dict]:
    return [
        {"name": name, "qty": qty, "cents": to_cents(value), "value": _dollars(value)}
        for name, (qty, value) in summarize(cards).by_source.items()
    ]


def _summary_rows(cards: Sequence[Card]) -> dict:
    s = summarize(cards)
    return {
        "byRarity": [
            {"name": name, "qty": qty, "cents": to_cents(value), "value": _dollars(value)}
            for name, (qty, value) in s.by_rarity.items()
        ],
        "foilQuantity": s.foil_quantity,
        "foilValue": _dollars(s.foil_value),
        "medianPrice": _dollars(s.median_price),
        "maxPrice": _dollars(s.max_price),
    }


# --- rendering --------------------------------------------------------------


def _read_asset(name: str) -> str:
    with open(os.path.join(ASSETS_DIR, name), encoding="utf-8") as handle:
        return handle.read()


def _embed_json(payload: dict) -> str:
    """Serialize for embedding inside a <script> block.

    A card name is arbitrary text, so anything that could terminate the script
    block -- `</script`, `<!--` -- gets escaped. JSON has no `<`, `>` or `&`
    outside string values, so escaping them wholesale is safe and parses back to
    the identical object: "Ashnod's Altar" and a card literally named
    `</script>` both survive.

    U+2028 and U+2029 are legal in JSON strings but are line terminators in
    JavaScript source, so they are escaped too.
    """
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    for raw, escaped in (
        ("<", "\\u003c"),
        (">", "\\u003e"),
        ("&", "\\u0026"),
        ("\u2028", "\\u2028"),
        ("\u2029", "\\u2029"),
    ):
        text = text.replace(raw, escaped)
    return text


#: Splits the template's head content (title, styles) from the page body.
HEAD_MARKER = "<!--__HEAD_END__-->"

_SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
{head}
</head>
<body>
{body}
</body>
</html>
"""


def render_html(
    payload: dict, *, title: str = "MTG Collection Triage", standalone: bool = True
) -> str:
    """Assemble the single-file page: template + inlined CSS, JS and payload.

    Nothing is fetched at runtime. That is a hard requirement — the Artifact CSP
    blocks every external host — and it is asserted in tests rather than assumed.

    `standalone=True` emits a complete document to open from disk.
    `standalone=False` emits just the content, because the Artifact publisher
    supplies its own doctype, `<head>` and `<body>` and expects the file to
    start at the page content.
    """
    template = _read_asset("dashboard.html")
    body = (
        template.replace("/*__CSS__*/", _read_asset("dashboard.css"))
        .replace("/*__JS__*/", _read_asset("dashboard.js"))
        .replace("__PAYLOAD__", _embed_json(payload))
        .replace("__TITLE__", _escape(title))
        .replace("__GENERATED__", _escape(payload["meta"]["generatedAt"]))
    )
    if not standalone:
        return body.replace(HEAD_MARKER, "")

    head, _, rest = body.partition(HEAD_MARKER)
    return _SHELL.format(head=head.strip(), body=rest.strip())


def _escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_dashboard(
    paths: Sequence[str],
    *,
    title: str = "MTG Collection Triage",
    standalone: bool = True,
) -> str:
    """Convenience: load the given exports, merge, and render the page."""
    from .io import load_many

    raw = load_many(*paths)
    payload = build_payload(
        merge(raw), sources=[os.path.basename(p) for p in paths], raw=raw
    )
    return render_html(payload, title=title, standalone=standalone)
