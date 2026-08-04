"""Queries over the stored collection.

Filter names mirror `binders.filters.CRITERIA` so the web UI, the CLI and the
dashboards all describe a slice the same way. The implementation is SQL rather
than the Python predicates, because filtering 543 rows in the database and
paginating is the whole point of storing them.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "FILTERS",
    "SORTS",
    "SEALED_FILTERS",
    "SEALED_SORTS",
    "SUBJECTS",
    "Page",
    "query_holdings",
    "query_sealed",
    "totals",
    "sealed_totals",
    "distinct_values",
]

#: keyword -> (SQL fragment, value transform). Names match binders.filters.
#: Fragments are written table-qualified up front. An earlier version qualified
#: them afterwards with string replacement, which silently corrupts any fragment
#: where a column name appears as a substring of another token.
FILTERS = {
    "price_min": ("h.price_cents >= ?", lambda v: int(round(float(v) * 100))),
    "price_max": ("h.price_cents <= ?", lambda v: int(round(float(v) * 100))),
    "qty_min": ("h.quantity >= ?", int),
    "edition": ("h.edition = ?", str),
    "rarity": ("h.rarity = ?", str),
    "language": ("h.language = ?", str),
    "condition": ("h.condition = ?", str),
    "foil": ("h.foil = ?", lambda v: 1 if v in (True, 1, "1", "true", "on") else 0),
    "title_contains": ("LOWER(h.title) LIKE ?", lambda v: f"%{str(v).lower()}%"),
    "set_contains": ("LOWER(h.set_name) LIKE ?", lambda v: f"%{str(v).lower()}%"),
    "unpriced": ("h.price_cents IS NULL", None),
    "verdict": ("COALESCE(v.verdict, 'undecided') = ?", str),
}

SORTS = {
    "title": "h.title COLLATE NOCASE",
    "edition": "h.edition COLLATE NOCASE",
    "rarity": "h.rarity",
    "quantity": "h.quantity",
    "price": "h.price_cents",
    "total": "(COALESCE(h.price_cents, 0) * h.quantity)",
    "updated": "h.updated_at",
}

DEFAULT_SORT = "total"


class Page:
    """One screen of results, plus what the whole filtered set looks like.

    `matching_ids` is the full filtered set, not just this page. Bulk actions
    need it so "select all N matching this filter" acts on exactly that set —
    the distinction between it and "the 50 rows you can see" is the difference
    between a correct bulk edit and a destructive one.
    """

    __slots__ = ("rows", "total_rows", "page", "per_page", "sort", "direction")

    def __init__(self, rows, total_rows, page, per_page, sort, direction):
        self.rows = rows
        self.total_rows = total_rows
        self.page = page
        self.per_page = per_page
        self.sort = sort
        self.direction = direction

    @property
    def pages(self) -> int:
        return max(1, -(-self.total_rows // self.per_page))

    @property
    def has_prev(self) -> bool:
        return self.page > 1

    @property
    def has_next(self) -> bool:
        return self.page < self.pages

    @property
    def start_index(self) -> int:
        return 0 if not self.total_rows else (self.page - 1) * self.per_page + 1

    @property
    def end_index(self) -> int:
        return min(self.total_rows, self.page * self.per_page)


def _where(filters: Dict[str, Any]) -> Tuple[str, List[Any]]:
    clauses, params = [], []
    for key, value in (filters or {}).items():
        if value in (None, ""):
            continue
        if key not in FILTERS:
            raise ValueError(f"unknown filter {key!r}")
        fragment, transform = FILTERS[key]
        clauses.append(fragment)
        if transform is not None:
            params.append(transform(value))
    return (" AND ".join(clauses) if clauses else "1=1"), params


_BASE = """
FROM holdings h
LEFT JOIN verdicts v ON v.subject_kind = 'holding' AND v.subject_id = h.id
WHERE {where}
"""

# --- sealed ------------------------------------------------------------------
#
# Sealed products were importable but unreachable: rows landed in the table and
# no query, route or view could see them again. These give sealed the same
# treatment singles get, with the fields that actually differ — a release year
# and a cost basis instead of rarity and foil.

SEALED_FILTERS = {
    "price_min": ("s.price_cents >= ?", lambda v: int(round(float(v) * 100))),
    "price_max": ("s.price_cents <= ?", lambda v: int(round(float(v) * 100))),
    "qty_min": ("s.quantity >= ?", int),
    "set_code": ("s.set_code = ?", str),
    "year": ("s.release_year = ?", str),
    "condition": ("s.condition = ?", str),
    "unpriced": ("s.price_cents IS NULL", None),
    "unresolved": ("s.resolved = 0", None),
    "name_contains": (
        "(LOWER(s.product_name) LIKE ? OR LOWER(s.raw_name) LIKE ?)",
        lambda v: f"%{str(v).lower()}%",
    ),
    "verdict": ("COALESCE(v.verdict, 'undecided') = ?", str),
}

SEALED_SORTS = {
    "name": "COALESCE(NULLIF(s.product_name,''), s.raw_name) COLLATE NOCASE",
    "set": "s.set_code COLLATE NOCASE",
    "year": "s.release_year",
    "quantity": "s.quantity",
    "price": "s.price_cents",
    "total": "(COALESCE(s.price_cents, 0) * s.quantity)",
    "updated": "s.updated_at",
}

_SEALED_BASE = """
FROM sealed s
LEFT JOIN verdicts v ON v.subject_kind = 'sealed' AND v.subject_id = s.id
WHERE {where}
"""


def _sealed_where(filters):
    clauses, params = [], []
    for key, value in (filters or {}).items():
        if value in (None, ""):
            continue
        if key not in SEALED_FILTERS:
            raise ValueError(f"unknown filter {key!r}")
        fragment, transform = SEALED_FILTERS[key]
        clauses.append(fragment)
        if transform is not None:
            # name_contains binds the same value twice (product and raw name).
            params.extend([transform(value)] * fragment.count("?"))
    return (" AND ".join(clauses) if clauses else "1=1"), params


def query_sealed(
    conn: sqlite3.Connection,
    filters: Optional[Dict[str, Any]] = None,
    *,
    sort: str = "total",
    direction: str = "desc",
    page: int = 1,
    per_page: int = 50,
) -> Page:
    where, params = _sealed_where(filters)
    order = SEALED_SORTS.get(sort, SEALED_SORTS["total"])
    direction = "ASC" if str(direction).lower() == "asc" else "DESC"
    page = max(1, int(page))
    per_page = max(1, min(500, int(per_page)))

    body = _SEALED_BASE.format(where=where)
    total = conn.execute(f"SELECT COUNT(*) AS n {body}", params).fetchone()["n"]
    rows = conn.execute(
        f"SELECT s.*, COALESCE(v.verdict, 'undecided') AS verdict "
        f"{body} ORDER BY {order} {direction}, s.id ASC LIMIT ? OFFSET ?",
        params + [per_page, (page - 1) * per_page],
    ).fetchall()
    return Page(rows, total, page, per_page, sort, direction.lower())


def sealed_matching_ids(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> List[int]:
    where, params = _sealed_where(filters)
    body = _SEALED_BASE.format(where=where)
    return [r["id"] for r in conn.execute(f"SELECT s.id {body}", params).fetchall()]


def sealed_totals(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> dict:
    where, params = _sealed_where(filters)
    body = _SEALED_BASE.format(where=where)
    row = conn.execute(
        f"SELECT COUNT(*) AS rows, "
        f"COALESCE(SUM(s.quantity), 0) AS quantity, "
        f"COALESCE(SUM(COALESCE(s.price_cents, 0) * s.quantity), 0) AS value_cents, "
        f"SUM(CASE WHEN s.price_cents IS NULL THEN s.quantity ELSE 0 END) AS unpriced, "
        f"COALESCE(SUM(COALESCE(s.cost_basis_cents, 0) * s.quantity), 0) AS cost_cents, "
        f"SUM(CASE WHEN s.resolved = 0 THEN 1 ELSE 0 END) AS unresolved "
        f"{body}",
        params,
    ).fetchone()
    return {
        "rows": row["rows"],
        "quantity": row["quantity"],
        "value_cents": row["value_cents"],
        "unpriced": row["unpriced"] or 0,
        "cost_cents": row["cost_cents"],
        "unresolved": row["unresolved"] or 0,
    }


def sealed_by_year(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> List[dict]:
    """Value by release year — the appreciation axis for sealed product.

    Chronological, not sorted by value: the shape of the series is the finding
    (older precons climb, recent ones sit near release price).
    """
    where, params = _sealed_where(filters)
    body = _SEALED_BASE.format(where=where)
    rows = conn.execute(
        f"SELECT COALESCE(NULLIF(s.release_year,''), '—') AS year, "
        f"SUM(s.quantity) AS qty, "
        f"SUM(COALESCE(s.price_cents,0) * s.quantity) AS cents, "
        f"SUM(CASE WHEN s.price_cents IS NULL THEN s.quantity ELSE 0 END) AS unpriced "
        f"{body} GROUP BY year ORDER BY year",
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def sealed_distinct(conn: sqlite3.Connection, column: str) -> List[str]:
    if column not in {"set_code", "release_year", "condition"}:
        raise ValueError(f"cannot enumerate {column!r}")
    rows = conn.execute(
        f"SELECT DISTINCT {column} AS v FROM sealed WHERE {column} != '' "
        f"ORDER BY {column} COLLATE NOCASE"
    ).fetchall()
    return [r["v"] for r in rows]


#: What each subject kind is called in SQL and in the verdicts table. Bulk
#: actions consult this rather than hardcoding `holdings`.
SUBJECTS = {
    "holding": {
        "table": "holdings",
        "filters": FILTERS,
        "matching_ids": lambda conn, f: matching_ids(conn, f),
        "name_sql": "title",
        "extra_name_sql": "edition",
    },
    "sealed": {
        "table": "sealed",
        "filters": SEALED_FILTERS,
        "matching_ids": lambda conn, f: sealed_matching_ids(conn, f),
        "name_sql": "COALESCE(NULLIF(product_name,''), raw_name)",
        "extra_name_sql": "set_code",
    },
}


def query_holdings(
    conn: sqlite3.Connection,
    filters: Optional[Dict[str, Any]] = None,
    *,
    sort: str = DEFAULT_SORT,
    direction: str = "desc",
    page: int = 1,
    per_page: int = 50,
) -> Page:
    where, params = _where(filters)
    order = SORTS.get(sort, SORTS[DEFAULT_SORT])
    direction = "ASC" if str(direction).lower() == "asc" else "DESC"
    page = max(1, int(page))
    per_page = max(1, min(500, int(per_page)))

    body = _BASE.format(where=where)
    total = conn.execute(f"SELECT COUNT(*) AS n {body}", params).fetchone()["n"]
    rows = conn.execute(
        f"SELECT h.*, COALESCE(v.verdict, 'undecided') AS verdict "
        f"{body} ORDER BY {order} {direction}, h.id ASC LIMIT ? OFFSET ?",
        params + [per_page, (page - 1) * per_page],
    ).fetchall()

    return Page(rows, total, page, per_page, sort, direction.lower())


def matching_ids(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> List[int]:
    """Every holding id matching the filter — the whole set, unpaginated."""
    where, params = _where(filters)
    body = _BASE.format(where=where)
    return [r["id"] for r in conn.execute(f"SELECT h.id {body}", params).fetchall()]


def totals(conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None) -> dict:
    where, params = _where(filters)
    body = _BASE.format(where=where)
    row = conn.execute(
        f"SELECT COUNT(*) AS rows, "
        f"COALESCE(SUM(h.quantity), 0) AS quantity, "
        f"COALESCE(SUM(COALESCE(h.price_cents, 0) * h.quantity), 0) AS value_cents, "
        f"SUM(CASE WHEN h.price_cents IS NULL THEN h.quantity ELSE 0 END) AS unpriced "
        f"{body}",
        params,
    ).fetchone()
    return {
        "rows": row["rows"],
        "quantity": row["quantity"],
        "value_cents": row["value_cents"],
        "unpriced": row["unpriced"] or 0,
    }


#: The Card Kingdom bands from `binders.aggregate.CK_TIERS`, restated in cents
#: so the whole calculation stays integral. Floors descend; a card lands in the
#: first band it clears.
TIER_BANDS = (
    ("prime", "$20+", 2000, 60, 75),
    ("mid", "$5–$19.99", 500, 47, 62),
    ("bulk", "Under $5", 0, 20, 25),
)


def tier_breakdown(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> List[dict]:
    """Price bands with cash/credit estimates, integer cents throughout.

    Mirrors `binders.aggregate.price_tiers`: sum the band, then apply its rate
    once and round. Applying a rate per card and summing would round hundreds of
    times and drift from what the CLI reports.
    """
    where, params = _where(filters)
    body = _BASE.format(where=where)

    case = " ".join(
        f"WHEN COALESCE(h.price_cents, 0) >= {floor} THEN '{key}'"
        for key, _, floor, _, _ in TIER_BANDS
        if floor > 0
    )
    rows = conn.execute(
        f"SELECT CASE {case} ELSE 'bulk' END AS band, "
        f"SUM(h.quantity) AS qty, "
        f"SUM(COALESCE(h.price_cents, 0) * h.quantity) AS cents "
        f"{body} GROUP BY band",
        params,
    ).fetchall()
    found = {r["band"]: r for r in rows}

    out = []
    for key, label, _floor, cash_pct, credit_pct in TIER_BANDS:
        row = found.get(key)
        cents_total = (row["cents"] if row else 0) or 0
        out.append({
            "tier": key,
            "label": label,
            "quantity": (row["qty"] if row else 0) or 0,
            "marketCents": cents_total,
            "cashCents": round(cents_total * cash_pct / 100),
            "creditCents": round(cents_total * credit_pct / 100),
            "cashPct": cash_pct,
            "creditPct": credit_pct,
        })
    return out


def concentration(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> dict:
    """Cumulative share of value, richest row first.

    Priced rows only — an unpriced row contributing zero would flatten the tail
    and misrepresent the curve, the same reasoning the sealed dashboard uses.
    """
    where, params = _where(filters)
    body = _BASE.format(where=where)
    rows = conn.execute(
        f"SELECT COALESCE(h.price_cents,0) * h.quantity AS cents {body} "
        f"AND h.price_cents IS NOT NULL ORDER BY cents DESC",
        params,
    ).fetchall()

    values = [r["cents"] for r in rows if r["cents"] > 0]
    total = sum(values)
    if len(values) < 2 or total <= 0:
        return {"points": [], "marks": [], "pricedRows": len(values)}

    points, marks, wanted, next_mark, running = [], [], (50, 80, 90), 0, 0
    for index, cents_value in enumerate(values, start=1):
        running += cents_value
        pct = running / total * 100
        points.append({
            "n": index,
            "rowPct": round(index / len(values) * 100, 2),
            "valuePct": round(pct, 2),
        })
        while next_mark < len(wanted) and pct >= wanted[next_mark]:
            marks.append({"valuePct": wanted[next_mark], "rows": index})
            next_mark += 1

    return {"points": points, "marks": marks, "pricedRows": len(values)}


def top_sets(
    conn: sqlite3.Connection,
    filters: Optional[Dict[str, Any]] = None,
    limit: int = 12,
) -> List[dict]:
    """Highest-value sets, with the tail folded into one bucket.

    Past a dozen the bars stop being readable, and inventing a hue per set is
    worse than an honest "Other".
    """
    where, params = _where(filters)
    body = _BASE.format(where=where)
    rows = conn.execute(
        f"SELECT COALESCE(NULLIF(h.set_name,''), h.edition) AS name, "
        f"SUM(h.quantity) AS qty, "
        f"SUM(COALESCE(h.price_cents,0) * h.quantity) AS cents "
        f"{body} GROUP BY name ORDER BY cents DESC",
        params,
    ).fetchall()

    out = [
        {"name": r["name"], "quantity": r["qty"], "cents": r["cents"], "other": False}
        for r in rows[:limit]
    ]
    tail = rows[limit:]
    if tail:
        out.append({
            "name": f"Other ({len(tail)} sets)",
            "quantity": sum(r["qty"] for r in tail),
            "cents": sum(r["cents"] for r in tail),
            "other": True,
        })
    return out


def rarity_split(
    conn: sqlite3.Connection, filters: Optional[Dict[str, Any]] = None
) -> List[dict]:
    where, params = _where(filters)
    body = _BASE.format(where=where)
    order = {"mythic": 0, "rare": 1, "uncommon": 2, "common": 3}
    rows = conn.execute(
        f"SELECT COALESCE(NULLIF(h.rarity,''), 'unknown') AS name, "
        f"SUM(h.quantity) AS qty, "
        f"SUM(COALESCE(h.price_cents,0) * h.quantity) AS cents {body} GROUP BY name",
        params,
    ).fetchall()
    return sorted(
        ({"name": r["name"], "quantity": r["qty"], "cents": r["cents"]} for r in rows),
        key=lambda r: order.get(r["name"], 9),
    )


def distinct_values(conn: sqlite3.Connection, column: str) -> List[str]:
    if column not in {"edition", "rarity", "language", "condition", "set_name"}:
        raise ValueError(f"cannot enumerate {column!r}")
    rows = conn.execute(
        f"SELECT DISTINCT {column} AS v FROM holdings "
        f"WHERE {column} != '' ORDER BY {column} COLLATE NOCASE"
    ).fetchall()
    return [r["v"] for r in rows]
