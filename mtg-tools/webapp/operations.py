"""The undo log.

Built before any mutation exists, deliberately. Retrofitting undo onto
mutations that already ship is how half of them end up unreversible — and bulk
edits over 543 rows are exactly where one misclick costs an afternoon.

The model is an **inverse patch**: every mutating action records, in the same
transaction, the row state needed to put things back. Undo replays that state.
It is not a generic "diff the whole database" scheme — it stores only the rows
an operation touched, which keeps a 400-row bulk edit small and exact.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .db import now

__all__ = [
    "UNDOABLE_TABLES",
    "Operation",
    "snapshot_rows",
    "record",
    "undo",
    "recent",
    "latest_undoable",
]

#: Only these tables participate. Anything else must be reconstructible from
#: them, so an operation can never leave a half-reversible trail.
UNDOABLE_TABLES = ("holdings", "sealed", "verdicts", "sales", "imports", "staged_rows")


class Operation:
    """A recorded, reversible change."""

    __slots__ = ("id", "kind", "summary", "affected", "created_at", "reverted_at")

    def __init__(self, row: sqlite3.Row):
        self.id = row["id"]
        self.kind = row["kind"]
        self.summary = row["summary"]
        self.affected = row["affected"]
        self.created_at = row["created_at"]
        self.reverted_at = row["reverted_at"]

    @property
    def reverted(self) -> bool:
        return self.reverted_at is not None

    def __repr__(self) -> str:
        state = " (undone)" if self.reverted else ""
        return f"<Operation {self.id} {self.kind}: {self.summary}{state}>"


def _pk(table: str) -> Sequence[str]:
    """Primary key columns. `verdicts` is the one composite key."""
    if table == "verdicts":
        return ("subject_kind", "subject_id")
    return ("id",)


def snapshot_rows(
    conn: sqlite3.Connection, table: str, ids: Iterable
) -> List[Dict[str, Any]]:
    """Capture rows exactly as they are now, for later restoration.

    Call this *before* mutating. Rows that don't exist yet simply aren't
    captured, which is what makes an insert reverse into a delete.
    """
    if table not in UNDOABLE_TABLES:
        raise ValueError(f"{table} is not undoable")

    keys = _pk(table)
    ids = list(ids)
    if not ids:
        return []

    if len(keys) == 1:
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT * FROM {table} WHERE {keys[0]} IN ({placeholders})", ids
        ).fetchall()
    else:
        rows = []
        for key_tuple in ids:
            where = " AND ".join(f"{k} = ?" for k in keys)
            found = conn.execute(
                f"SELECT * FROM {table} WHERE {where}", tuple(key_tuple)
            ).fetchone()
            if found is not None:
                rows.append(found)

    return [dict(r) for r in rows]


def record(
    conn: sqlite3.Connection,
    kind: str,
    summary: str,
    *,
    before: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    created: Optional[Dict[str, List]] = None,
    affected: int = 0,
) -> int:
    """Write one undo entry. Must be called inside the mutation's transaction.

    `before`  — {table: [row dicts as they were]}; restored on undo.
    `created` — {table: [primary keys that did not exist before]}; deleted on undo.

    A row that appears in both is handled correctly: `created` deletes run first,
    then `before` restores, so an update that also inserted reverses cleanly.
    """
    inverse = {
        "before": before or {},
        "created": {k: [list(i) if isinstance(i, (list, tuple)) else i for i in v]
                    for k, v in (created or {}).items()},
    }
    for table in list(inverse["before"]) + list(inverse["created"]):
        if table not in UNDOABLE_TABLES:
            raise ValueError(f"{table} is not undoable")

    cursor = conn.execute(
        "INSERT INTO operations (kind, summary, affected, inverse, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (kind, summary, affected, json.dumps(inverse), now()),
    )
    return cursor.lastrowid


def undo(conn: sqlite3.Connection, operation_id: Optional[int] = None) -> Operation:
    """Reverse one operation. Defaults to the most recent un-reverted one.

    Deliberately strict: only the newest un-reverted operation can be undone.
    Undoing out of order would silently produce a state neither the user nor the
    log describes — a bulk price edit undone *after* a later merge would restore
    prices onto rows the merge has since collapsed.
    """
    target = _resolve_target(conn, operation_id)
    inverse = json.loads(
        conn.execute(
            "SELECT inverse FROM operations WHERE id = ?", (target.id,)
        ).fetchone()["inverse"]
    )

    # Deletes first: an operation that both created and updated rows reverses
    # cleanly only in this order.
    for table, keys in inverse.get("created", {}).items():
        pk = _pk(table)
        for key in keys:
            values = key if isinstance(key, list) else [key]
            where = " AND ".join(f"{c} = ?" for c in pk)
            conn.execute(f"DELETE FROM {table} WHERE {where}", tuple(values))

    for table, rows in inverse.get("before", {}).items():
        for row in rows:
            columns = list(row)
            placeholders = ",".join("?" for _ in columns)
            conn.execute(
                f"INSERT OR REPLACE INTO {table} ({','.join(columns)}) "
                f"VALUES ({placeholders})",
                tuple(row[c] for c in columns),
            )

    conn.execute(
        "UPDATE operations SET reverted_at = ? WHERE id = ?", (now(), target.id)
    )
    return target


def _resolve_target(conn: sqlite3.Connection, operation_id: Optional[int]) -> Operation:
    newest = conn.execute(
        "SELECT * FROM operations WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if newest is None:
        raise LookupError("nothing to undo")

    if operation_id is None:
        return Operation(newest)

    row = conn.execute(
        "SELECT * FROM operations WHERE id = ?", (operation_id,)
    ).fetchone()
    if row is None:
        raise LookupError(f"no operation {operation_id}")
    if row["reverted_at"] is not None:
        raise LookupError(f"operation {operation_id} is already undone")
    if row["id"] != newest["id"]:
        raise LookupError(
            f"operation {operation_id} is not the most recent change "
            f"(that is #{newest['id']}: {newest['summary']}). "
            f"Undo works newest-first so the result always matches the log."
        )
    return Operation(row)


def recent(conn: sqlite3.Connection, limit: int = 25) -> List[Operation]:
    rows = conn.execute(
        "SELECT * FROM operations ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [Operation(r) for r in rows]


def latest_undoable(conn: sqlite3.Connection) -> Optional[Operation]:
    row = conn.execute(
        "SELECT * FROM operations WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return Operation(row) if row else None
