"""The sale lifecycle: listed → sold → fees → net → realized gain.

This closes the loop the vault's tax and insurance plan needs. Until now the
ledger's sale columns were always blank, because nothing recorded that a card
had actually gone out the door.

Money stays in integer cents through every step. Net proceeds and realized gain
are **computed and stored**, not derived at read time, so a ledger exported in
January still says what it said in January even if a price moved since.

Cost basis is deliberately *not* invented. Where a row has none, realized gain
is `NULL` rather than "equal to the sale price" — the vault's plan is a
batch-level good-faith reconstruction from order history, and a fabricated
basis would quietly turn into a tax number.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional, Sequence

from . import operations as ops
from .db import now, to_cents

__all__ = [
    "SaleError",
    "STATUSES",
    "list_for_sale",
    "record_listing",
    "record_sale",
    "cancel",
    "sale_rows",
    "summary",
]


class SaleError(ValueError):
    """A sale request that should not be recorded."""


STATUSES = ("listed", "sold", "cancelled")

KINDS = ("holding", "sealed")


def _table(kind: str) -> str:
    if kind not in KINDS:
        raise SaleError(f"{kind!r} is not a sellable kind")
    return "holdings" if kind == "holding" else "sealed"


def _subject(conn: sqlite3.Connection, kind: str, subject_id: int):
    row = conn.execute(
        f"SELECT * FROM {_table(kind)} WHERE id = ?", (subject_id,)
    ).fetchone()
    if row is None:
        raise SaleError(f"No {kind} {subject_id}.")
    return row


def _name(kind: str, row) -> str:
    if kind == "holding":
        return row["title"] + (" (foil)" if row["foil"] else "")
    return row["product_name"] or row["raw_name"]


def _cost_basis_cents(kind: str, row, quantity: int) -> Optional[int]:
    """Per-unit cost basis × quantity, or None when there is none recorded."""
    if kind != "sealed":
        return None
    basis = row["cost_basis_cents"]
    return None if basis is None else basis * quantity


# --- the queue ----------------------------------------------------------------


def list_for_sale(conn: sqlite3.Connection) -> List[dict]:
    """Everything marked sell, with whatever sale record it already has.

    Driven by verdicts, so the triage decision made in the collection view is
    what populates this — the two are not separate piles.
    """
    rows = []
    for kind in KINDS:
        table = _table(kind)
        for row in conn.execute(
            f"SELECT s.*, v.decided_at FROM {table} s "
            f"JOIN verdicts v ON v.subject_kind = ? AND v.subject_id = s.id "
            f"WHERE v.verdict = 'sell' "
            f"ORDER BY (COALESCE(s.price_cents,0) * s.quantity) DESC",
            (kind,),
        ).fetchall():
            sale = conn.execute(
                "SELECT * FROM sales WHERE subject_kind = ? AND subject_id = ? "
                "AND status != 'cancelled' ORDER BY id DESC LIMIT 1",
                (kind, row["id"]),
            ).fetchone()
            rows.append({
                "kind": kind,
                "id": row["id"],
                "name": _name(kind, row),
                "setCode": row["edition"] if kind == "holding" else row["set_code"],
                "quantity": row["quantity"],
                "priceCents": row["price_cents"],
                "marketCents": (row["price_cents"] or 0) * row["quantity"],
                "costBasisCents": _cost_basis_cents(kind, row, row["quantity"]),
                "sale": dict(sale) if sale else None,
            })
    rows.sort(key=lambda r: r["marketCents"], reverse=True)
    return rows


# --- transitions --------------------------------------------------------------


def record_listing(
    conn: sqlite3.Connection,
    kind: str,
    subject_id: int,
    *,
    channel: str = "",
    listed_cents: Optional[int] = None,
    quantity: Optional[int] = None,
    notes: str = "",
) -> int:
    """Mark something listed. Defaults to the whole holding at market price."""
    row = _subject(conn, kind, subject_id)
    quantity = int(quantity or row["quantity"])
    if quantity <= 0 or quantity > row["quantity"]:
        raise SaleError(
            f"Cannot list {quantity} of {row['quantity']} — pick between 1 and "
            f"{row['quantity']}."
        )

    open_sale = conn.execute(
        "SELECT id FROM sales WHERE subject_kind = ? AND subject_id = ? "
        "AND status = 'listed'",
        (kind, subject_id),
    ).fetchone()
    if open_sale:
        raise SaleError("That is already listed. Record the sale or cancel it first.")

    if listed_cents is None:
        listed_cents = (row["price_cents"] or 0) * quantity

    stamp = now()
    cursor = conn.execute(
        "INSERT INTO sales (subject_kind, subject_id, subject_name, subject_set, "
        "quantity, channel, status, listed_at, listed_cents, cost_basis_cents, "
        "notes, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'listed', ?, ?, ?, ?, ?, ?)",
        (
            kind, subject_id, _name(kind, row),
            row["edition"] if kind == "holding" else row["set_code"],
            quantity, channel, stamp, listed_cents,
            _cost_basis_cents(kind, row, quantity), notes, stamp, stamp,
        ),
    )
    sale_id = cursor.lastrowid

    ops.record(
        conn,
        "sale_listed",
        f"Listed {_name(kind, row)} ×{quantity}",
        created={"sales": [sale_id]},
        affected=1,
    )
    return sale_id


def record_sale(
    conn: sqlite3.Connection,
    sale_id: int,
    *,
    sold_cents: int,
    fees_cents: int = 0,
    shipping_cents: int = 0,
    sold_at: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Close a listing. Computes and stores net and realized gain.

    Quantity is deducted from the holding: a sold card is no longer owned, and
    leaving it in the collection would inflate every valuation after the fact.
    """
    sale = conn.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
    if sale is None:
        raise SaleError(f"No sale {sale_id}.")
    if sale["status"] != "listed":
        raise SaleError(f"That sale is already {sale['status']}.")

    for label, value in (
        ("Sale price", sold_cents),
        ("Fees", fees_cents),
        ("Shipping", shipping_cents),
    ):
        if value is None or int(value) < 0:
            raise SaleError(f"{label} cannot be negative.")

    net = int(sold_cents) - int(fees_cents) - int(shipping_cents)
    basis = sale["cost_basis_cents"]
    # None, not zero: an unknown basis must not become a realized gain equal to
    # the whole sale price, which would land straight in a tax figure.
    gain = None if basis is None else net - basis

    kind, subject_id = sale["subject_kind"], sale["subject_id"]
    table = _table(kind)
    row = _subject(conn, kind, subject_id)

    before = {
        "sales": ops.snapshot_rows(conn, "sales", [sale_id]),
        table: ops.snapshot_rows(conn, table, [subject_id]),
    }

    stamp = now()
    conn.execute(
        "UPDATE sales SET status = 'sold', sold_at = ?, sold_cents = ?, "
        "fees_cents = ?, shipping_cents = ?, net_cents = ?, "
        "realized_gain_cents = ?, notes = COALESCE(?, notes), updated_at = ? "
        "WHERE id = ?",
        (
            sold_at or stamp, int(sold_cents), int(fees_cents), int(shipping_cents),
            net, gain, notes, stamp, sale_id,
        ),
    )

    remaining = row["quantity"] - sale["quantity"]
    if remaining > 0:
        conn.execute(
            f"UPDATE {table} SET quantity = ?, version = version + 1, updated_at = ? "
            f"WHERE id = ?",
            (remaining, stamp, subject_id),
        )
    else:
        conn.execute(
            "DELETE FROM verdicts WHERE subject_kind = ? AND subject_id = ?",
            (kind, subject_id),
        )
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (subject_id,))
        before.setdefault("verdicts", []).extend(
            ops.snapshot_rows(conn, "verdicts", [(kind, subject_id)])
        )

    ops.record(
        conn,
        "sale_recorded",
        f"Sold {_name(kind, row)} ×{sale['quantity']}",
        before=before,
        affected=1,
    )

    return {
        "saleId": sale_id,
        "netCents": net,
        "realizedGainCents": gain,
        "removedFromCollection": remaining <= 0,
    }


def cancel(conn: sqlite3.Connection, sale_id: int) -> None:
    sale = conn.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
    if sale is None:
        raise SaleError(f"No sale {sale_id}.")
    if sale["status"] == "sold":
        raise SaleError("That already sold — undo it from History instead.")

    before = {"sales": ops.snapshot_rows(conn, "sales", [sale_id])}
    conn.execute(
        "UPDATE sales SET status = 'cancelled', updated_at = ? WHERE id = ?",
        (now(), sale_id),
    )
    ops.record(conn, "sale_cancelled", "Cancelled a listing", before=before, affected=1)


# --- reading ------------------------------------------------------------------


def sale_rows(conn: sqlite3.Connection, status: Optional[str] = None) -> List[dict]:
    clause, params = "", []
    if status:
        if status not in STATUSES:
            raise SaleError(f"{status!r} is not a sale status")
        clause, params = "WHERE s.status = ?", [status]

    rows = []
    for sale in conn.execute(
        f"SELECT * FROM sales s {clause} ORDER BY s.id DESC", params
    ).fetchall():
        table = _table(sale["subject_kind"])
        subject = conn.execute(
            f"SELECT * FROM {table} WHERE id = ?", (sale["subject_id"],)
        ).fetchone()
        rows.append({
            **dict(sale),
            # The subject is gone once a full quantity sells, which is correct;
            # subject_name was captured at listing time so the record survives.
            "name": _name(sale["subject_kind"], subject)
            if subject
            else (sale["subject_name"] or None),
        })
    return rows


def summary(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS n, "
        "COALESCE(SUM(sold_cents),0) AS gross, "
        "COALESCE(SUM(fees_cents),0) + COALESCE(SUM(shipping_cents),0) AS costs, "
        "COALESCE(SUM(net_cents),0) AS net "
        "FROM sales WHERE status = 'sold'"
    ).fetchone()
    gain = conn.execute(
        "SELECT COALESCE(SUM(realized_gain_cents),0) AS gain, "
        "COUNT(realized_gain_cents) AS known "
        "FROM sales WHERE status = 'sold'"
    ).fetchone()
    listed = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(listed_cents),0) AS cents "
        "FROM sales WHERE status = 'listed'"
    ).fetchone()

    return {
        "soldCount": row["n"],
        "grossCents": row["gross"],
        "costsCents": row["costs"],
        "netCents": row["net"],
        "realizedGainCents": gain["gain"],
        # How many sold rows actually had a cost basis. Without this the gain
        # figure reads as complete when it may cover a fraction of the sales.
        "gainKnownFor": gain["known"],
        "listedCount": listed["n"],
        "listedCents": listed["cents"],
    }
