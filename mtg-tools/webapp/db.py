"""SQLite access for the collection manager.

Two rules the rest of the app depends on:

**Money is integer cents.** Never float, never REAL. `binders` goes to some
trouble to keep money exact with `Decimal`; storing it as REAL here would undo
that at the persistence layer, where it would be hardest to notice.

**Every mutation runs inside `transaction()`.** That is also where the undo log
is written, so an operation and its inverse commit together or not at all.
"""

from __future__ import annotations

import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterator, Optional

__all__ = [
    "SCHEMA_PATH",
    "DEFAULT_DB",
    "connect",
    "memory_uri",
    "is_memory",
    "init_db",
    "transaction",
    "now",
    "to_cents",
    "from_cents",
    "format_cents",
    "money_columns",
]

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "schema.sql")

#: The database lives next to the repo by default, never inside it — it holds
#: real collection values and the repo is public.
DEFAULT_DB = os.environ.get(
    "MTG_DB", os.path.expanduser("~/.local/share/mtg-tools/collection.db")
)

SCHEMA_VERSION = 1


def now() -> str:
    """UTC ISO-8601, second precision — the app's single timestamp format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- money -------------------------------------------------------------------


def to_cents(value) -> Optional[int]:
    """Decimal/str dollars -> integer cents. `None` stays `None`.

    `None` means "no price recorded", which is not the same as zero. The
    distinction matters: a sealed deck with no price is unvalued, not worthless.
    """
    if value is None or value == "":
        return None
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return int(value.quantize(Decimal("0.01")) * 100)


def from_cents(cents: Optional[int]) -> Optional[Decimal]:
    if cents is None:
        return None
    return (Decimal(cents) / 100).quantize(Decimal("0.01"))


def format_cents(cents: Optional[int], dash: str = "—") -> str:
    if cents is None:
        return dash
    sign = "-" if cents < 0 else ""
    whole, rest = divmod(abs(cents), 100)
    return f"{sign}${whole:,}.{rest:02d}"


def money_columns(conn: sqlite3.Connection) -> list:
    """Every column whose name implies money, with its declared type.

    Used by the test that asserts none of them is REAL. Keeping the check in
    the app rather than only in tests means a future migration that adds a REAL
    price column fails loudly.
    """
    found = []
    for (table,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall():
        for row in conn.execute(f"PRAGMA table_info({table})").fetchall():
            name, decl = row[1], (row[2] or "").upper()
            if re.search(r"(cents|price|cost|fee|amount|value)", name, re.I):
                found.append((table, name, decl))
    return found


# --- connection --------------------------------------------------------------


def memory_uri(name: Optional[str] = None) -> str:
    """A private in-memory database that several connections can share.

    A plain `:memory:` database belongs to the single connection that opened it,
    so a second connection sees an empty one. The app opens a connection per
    thread, so tests have to use a shared-cache URI or they would exercise a
    different code path than the running server — which is exactly how a
    thread-affinity bug reached a live server with 53 tests passing.
    """
    return f"file:{name or 'mtg-' + secrets.token_hex(8)}?mode=memory&cache=shared"


def is_memory(path: str) -> bool:
    return path == ":memory:" or "mode=memory" in path


def connect(path: Optional[str] = None) -> sqlite3.Connection:
    """Open one connection. The app opens one per thread; see `webapp.app.db`."""
    target = path or DEFAULT_DB
    uri = target.startswith("file:")

    if not uri and not is_memory(target):
        os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)

    conn = sqlite3.connect(target, isolation_level=None, uri=uri)  # explicit txns
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    if not is_memory(target):
        # WAL is what makes per-thread connections workable: concurrent readers
        # alongside one writer, with BEGIN IMMEDIATE serializing the writes.
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create the schema if absent. Idempotent."""
    with open(SCHEMA_PATH, encoding="utf-8") as handle:
        conn.executescript(handle.read())

    _add_missing_columns(conn)

    row = conn.execute("SELECT version FROM schema_version").fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,))
    elif row["version"] != SCHEMA_VERSION:
        raise RuntimeError(
            f"database is schema v{row['version']}, this build expects "
            f"v{SCHEMA_VERSION} — no migration path is defined yet"
        )


#: Columns added after the first release. Applied idempotently so an existing
#: database picks them up without a migration framework.
LATE_COLUMNS = (
    ("sales", "subject_name", "TEXT NOT NULL DEFAULT ''"),
    ("sales", "subject_set", "TEXT NOT NULL DEFAULT ''"),
)


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    for table, column, decl in LATE_COLUMNS:
        existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Explicit transaction. Rolls back on any exception.

    IMMEDIATE so a second writer fails fast against `busy_timeout` instead of
    deadlocking halfway through a bulk edit.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
