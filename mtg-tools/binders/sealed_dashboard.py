"""The keep/sell triage page for sealed commander decks.

Deliberately *not* a copy of the singles dashboard. Two things differ, and both
are about not inventing numbers:

1. **No Card Kingdom rate bands.** The singles page shows cash and credit at
   60/47/20% and 75/62/25% — those are CK's singles buylist rates, and sealed
   product isn't going to CK. Applying them here would produce a figure
   corresponding to no real offer, so the sell total is the marked pile's market
   value and nothing else. Gain/loss appears separately, because that is
   arithmetic on an entered cost basis rather than an assumed rate.

2. **Unpriced decks are surfaced, not hidden.** Every ManaBox single carries a
   price; sealed prices are entered by hand, so a partial valuation is the normal
   state. The unpriced count rides next to the total and one of the four charts
   is coverage, so a number can't read as complete when half the shelf is blank.

The visual system is shared wholesale — same `dashboard.css`, same validated
palette, same mark specs.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .aggregate import cents
from .dashboard import HEAD_MARKER, _embed_json, _escape, _read_asset, to_cents
from .sealed import Issue, SealedHolding, summarize_sealed

__all__ = [
    "FLAG_LABELS",
    "build_sealed_payload",
    "render_sealed_html",
    "build_sealed_dashboard",
]

#: Reuses the codes `sealed.resolve` already emits, so the page and the CLI
#: agree on what counts as a problem.
FLAG_LABELS = {
    "ambiguous": "Matches more than one printing — add a Set to pin it",
    "unmatched": "No known commander deck matched this name",
    "no-price": "No price recorded yet",
    "no-price-date": "Priced but undated — an undated valuation won't support a claim",
    "collectors-edition-exists": "A Collector's Edition of this deck also exists",
    "condition": "Unrecognized condition",
    "bad-quantity": "Invalid quantity",
    "no-name": "Row has no deck name",
}

TOP_DECKS = 15


def _dollars(value) -> str:
    return f"${cents(value):,.2f}"


def build_sealed_payload(
    holdings: Sequence[SealedHolding],
    issues: Iterable[Issue] = (),
    *,
    source_file: str = "",
    generated_at: Optional[datetime] = None,
) -> dict:
    """Everything the sealed page needs, with money already resolved in Python.

    Per-deck prices cross as integer cents so the browser's running total for the
    marked pile stays exact — same discipline as the singles page.
    """
    holdings = list(holdings)
    ordered = sorted(
        holdings, key=lambda h: (h.total_value, h.quantity), reverse=True
    )
    summary = summarize_sealed(ordered)

    flags: Dict[str, List[str]] = {}
    candidates: Dict[str, List[str]] = {}
    for issue in issues:
        if issue.holding is None:
            continue
        key = issue.holding.identity
        bucket = flags.setdefault(key, [])
        if issue.code not in bucket:
            bucket.append(issue.code)
        if issue.code == "ambiguous" and issue.holding.candidates:
            candidates[key] = [
                f"{d.set_code} ({d.year})" for d in issue.holding.candidates
            ]

    decks = []
    for h in ordered:
        deck = h.deck
        decks.append(
            {
                "id": h.identity,
                "name": deck.name if deck else h.raw_name,
                "display": h.display,
                "setCode": h.set_code,
                "setName": deck.set_name if deck else "",
                "year": h.year,
                "qty": h.quantity,
                "cents": to_cents(h.price) if h.price is not None else None,
                "totalCents": to_cents(h.total_value),
                "costCents": to_cents(h.total_cost) if h.total_cost is not None else None,
                "gainCents": to_cents(h.gain) if h.gain is not None else None,
                "condition": h.condition,
                "priceDate": h.price_date.isoformat() if h.price_date else "",
                "priceSource": h.source,
                "notes": h.notes,
                "resolved": h.resolved,
                "match": h.match,
                # 207 of 220 catalog decks carry a purchase URL. Prices are
                # manual, so this turns each row into a click instead of a search.
                "url": deck.tcgplayer_url if deck else "",
                "flags": flags.get(h.identity, []),
                "candidates": candidates.get(h.identity, []),
            }
        )

    priced_cents = sum(d["totalCents"] for d in decks if d["cents"] is not None)

    return {
        "meta": {
            "generatedAt": (generated_at or datetime.now(timezone.utc)).isoformat(
                timespec="seconds"
            ),
            "file": os.path.basename(source_file) if source_file else "",
            "rows": summary.rows,
            "quantity": summary.quantity,
            "totalCents": to_cents(summary.total_value),
            "totalValue": _dollars(summary.total_value),
            "pricedQuantity": summary.priced_quantity,
            "unpricedQuantity": summary.unpriced_quantity,
            "unresolvedRows": summary.unresolved_rows,
            "fullyPriced": summary.fully_priced,
            "costCents": to_cents(summary.total_cost) if summary.total_cost else None,
            "gainCents": to_cents(summary.total_gain) if summary.total_gain else None,
            "oldestPriceDate": summary.oldest_price_date.isoformat()
            if summary.oldest_price_date
            else "",
            "newestPriceDate": summary.newest_price_date.isoformat()
            if summary.newest_price_date
            else "",
        },
        "flagLabels": FLAG_LABELS,
        "decks": decks,
        "byYear": _year_rows(ordered),
        "coverage": _coverage(ordered),
        "concentration": _concentration(decks, priced_cents),
    }


def _year_rows(holdings: Sequence[SealedHolding]) -> List[dict]:
    """Value by release year — the appreciation axis for sealed product.

    Chronological rather than sorted by value: the shape of the series is the
    point (older precons climb, recent ones sit near MSRP), and reordering it
    would destroy that.
    """
    buckets: Dict[str, List[SealedHolding]] = {}
    for h in holdings:
        buckets.setdefault(h.year or "—", []).append(h)

    rows = []
    for year in sorted(buckets):
        group = buckets[year]
        value = sum((h.total_value for h in group), Decimal("0"))
        rows.append(
            {
                "year": year,
                "qty": sum(h.quantity for h in group),
                "cents": to_cents(value),
                "value": _dollars(value),
                "unpriced": sum(h.quantity for h in group if not h.has_price),
            }
        )
    return rows


def _coverage(holdings: Sequence[SealedHolding]) -> dict:
    """Priced vs unpriced, so a partial valuation announces itself."""
    priced = [h for h in holdings if h.has_price]
    unpriced = [h for h in holdings if not h.has_price]
    return {
        "pricedDecks": sum(h.quantity for h in priced),
        "unpricedDecks": sum(h.quantity for h in unpriced),
        "pricedRows": len(priced),
        "unpricedRows": len(unpriced),
        "pricedCents": to_cents(sum((h.total_value for h in priced), Decimal("0"))),
    }


def _concentration(decks: Sequence[dict], total_cents: int) -> dict:
    """Cumulative share of value, richest deck first.

    Computed over priced decks only — an unpriced deck contributing 0 would
    flatten the tail and misrepresent the curve.
    """
    priced = [d for d in decks if d["cents"] is not None and d["totalCents"] > 0]
    if not priced or total_cents <= 0:
        return {"points": [], "marks": []}

    points = []
    marks = []
    wanted = [50, 80, 90]
    next_mark = 0
    running = 0

    for index, deck in enumerate(priced, start=1):
        running += deck["totalCents"]
        pct = running / total_cents * 100
        points.append(
            {
                "n": index,
                "rowPct": round(index / len(priced) * 100, 3),
                "valuePct": round(pct, 3),
            }
        )
        while next_mark < len(wanted) and pct >= wanted[next_mark]:
            marks.append(
                {
                    "valuePct": wanted[next_mark],
                    "rows": index,
                    "rowPct": round(index / len(priced) * 100, 1),
                }
            )
            next_mark += 1

    return {"points": points, "marks": marks}


# --- rendering --------------------------------------------------------------


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


def render_sealed_html(
    payload: dict,
    *,
    title: str = "Sealed Collection Triage",
    standalone: bool = True,
) -> str:
    """Assemble the single-file page.

    `dashboard.css` is shared verbatim with the singles page — it is entirely
    token-driven, so both pages get the same validated palette and both themes
    from one file.
    """
    template = _read_asset("sealed_dashboard.html")
    body = (
        template.replace("/*__CSS__*/", _read_asset("dashboard.css"))
        .replace("/*__JS__*/", _read_asset("sealed_dashboard.js"))
        .replace("__PAYLOAD__", _embed_json(payload))
        .replace("__TITLE__", _escape(title))
        .replace("__GENERATED__", _escape(payload["meta"]["generatedAt"]))
    )
    if not standalone:
        return body.replace(HEAD_MARKER, "")

    head, _, rest = body.partition(HEAD_MARKER)
    return _SHELL.format(head=head.strip(), body=rest.strip())


def build_sealed_dashboard(
    path,
    *,
    title: str = "Sealed Collection Triage",
    standalone: bool = True,
) -> str:
    """Convenience: load a sealed.csv, resolve it, and render the page."""
    from .sealed import load_sealed, resolve

    holdings, issues = resolve(load_sealed(path))
    payload = build_sealed_payload(holdings, issues, source_file=os.fspath(path))
    return render_sealed_html(payload, title=title, standalone=standalone)
