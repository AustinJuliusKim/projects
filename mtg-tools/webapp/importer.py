"""Ingest: upload -> stage -> doctor -> commit.

The invariant that makes this safe: **canonical data is untouched until commit.**
An upload lands in `staged_rows`, issues are surfaced from the same
`io.validate` / `sealed.resolve` the CLI uses, and only an explicit commit
writes to `holdings` or `sealed` — as one transaction, with one undo entry.
"""

from __future__ import annotations

import csv
import hashlib
import io as _io
import json
import sqlite3
from typing import Any, Dict, List, Optional, Sequence, Tuple

from binders.catalog import load_catalog
from binders.io import MANABOX_COLUMNS, canonical_header, parse_row, validate
from binders.model import Card
from binders.sealed import SEALED_COLUMNS, SealedHolding, resolve
from binders.sealed import _parse_date as _parse_sealed_date
from binders.sealed import _parse_money as _parse_sealed_money

from . import operations as ops
from .db import now, to_cents

__all__ = ["DetectionError", "detect_kind", "stage_import", "issues_for", "commit_import",
           "discard_import"]


class DetectionError(ValueError):
    """The uploaded file isn't a shape we recognize."""


def _sniff(text: str) -> List[str]:
    reader = csv.reader(_io.StringIO(text))
    for row in reader:
        return [c.strip() for c in row]
    return []


def detect_kind(text: str) -> Tuple[str, str]:
    """Return (kind, dialect-description) for an uploaded CSV.

    Singles are recognized through `binders.io.canonical_header`, which already
    understands both ManaBox header dialects — the current `Title,Edition,...`
    and the older `Name,Set code,...` in a different column order. Sealed files
    are recognized by their own header.

    **The order of the two tests is load-bearing.** The formats overlap: a
    legacy ManaBox export begins `Name,Set code,…,Quantity,…`, so it satisfies
    any sealed test loose enough to accept a hand-written deck list. Asking the
    strict question first — six or more columns mapping onto ManaBox's schema —
    is what lets the second one be as loose as its own error message promises.
    """
    header = _sniff(text)
    if not header:
        raise DetectionError("The file is empty.")

    mapping = canonical_header(header)
    canonical = set(mapping.values())
    if "Title" in canonical:
        known = len(canonical & set(MANABOX_COLUMNS))
        dialect = "ManaBox (current)" if "Title" in header else "ManaBox (legacy Name/Set code)"
        if known >= 6:
            return "singles", dialect

    # Sealed lists are hand-written and start life as two columns — that is what
    # `sealed template` produces and what the note in the vault describes. This
    # previously also demanded a Set, Price date or Cost basis column, which
    # rejected the very file the message below tells people to build.
    lowered = {h.lower() for h in header}
    if {"name", "quantity"} <= lowered:
        return "sealed", "sealed.csv"

    raise DetectionError(
        "Couldn't tell what this file is. Expected a ManaBox export (a Title or "
        "Name column) or a sealed list (Name + Quantity). Header was: "
        + ", ".join(header[:8])
    )


# --- staging ------------------------------------------------------------------


def stage_import(
    conn: sqlite3.Connection, filename: str, data: bytes
) -> Tuple[int, str]:
    """Parse an upload into `staged_rows`. Returns (import_id, kind).

    Raises `DetectionError` on an unrecognized shape and `FileExistsError` if
    this exact file has already been committed — re-importing the same export
    would double every quantity, which is the single most likely way to corrupt
    a collection by accident.
    """
    text = data.decode("utf-8-sig", errors="replace")
    digest = hashlib.sha256(data).hexdigest()

    prior = conn.execute(
        "SELECT id, filename, committed_at FROM imports "
        "WHERE sha256 = ? AND status = 'committed'",
        (digest,),
    ).fetchone()
    if prior is not None:
        raise FileExistsError(
            f"This exact file was already imported as “{prior['filename']}” on "
            f"{(prior['committed_at'] or '')[:10]}. Importing it again would "
            f"double those quantities."
        )

    kind, dialect = detect_kind(text)

    cursor = conn.execute(
        "INSERT INTO imports (filename, sha256, kind, dialect, status, created_at) "
        "VALUES (?, ?, ?, ?, 'staged', ?)",
        (filename, digest, kind, dialect, now()),
    )
    import_id = cursor.lastrowid

    rows = list(csv.DictReader(_io.StringIO(text)))
    staged = _stage_singles(rows) if kind == "singles" else _stage_sealed(rows)

    conn.executemany(
        "INSERT INTO staged_rows (import_id, line_no, raw, parsed, issues, state) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (import_id, i, json.dumps(r["raw"]), json.dumps(r["parsed"]),
             json.dumps(r["issues"]), r["state"])
            for i, r in enumerate(staged, start=2)
        ],
    )
    conn.execute(
        "UPDATE imports SET row_count = ? WHERE id = ?", (len(staged), import_id)
    )
    return import_id, kind


def _stage_singles(rows: Sequence[dict]) -> List[dict]:
    cards = [parse_row(r) for r in rows if any((v or "").strip() for v in r.values())]
    by_index = {id(c): i for i, c in enumerate(cards)}

    problems: Dict[int, List[str]] = {}
    for issue in validate(cards):
        if issue.card is not None:
            problems.setdefault(by_index[id(issue.card)], []).append(issue.code)

    staged = []
    for index, card in enumerate(cards):
        codes = problems.get(index, [])
        staged.append({
            "raw": rows[index] if index < len(rows) else {},
            "parsed": _card_fields(card),
            "issues": codes,
            # Only an error blocks a commit; warnings are informational.
            "state": "pending" if _blocking(codes) else "resolved",
        })
    return staged


def _stage_sealed(rows: Sequence[dict]) -> List[dict]:
    holdings = []
    for index, row in enumerate(rows, start=2):
        if not any((v or "").strip() for v in row.values()):
            continue
        qty = (row.get("Quantity") or "1").strip()
        holdings.append(SealedHolding(
            raw_name=(row.get("Name") or "").strip(),
            set_hint=(row.get("Set") or "").strip(),
            quantity=int(qty) if qty.lstrip("-").isdigit() else 1,
            condition=((row.get("Condition") or "sealed").strip().lower() or "sealed"),
            # The money columns. An earlier version read only name, set,
            # quantity and condition, so every sealed import silently dropped
            # its prices — invisible until sealed rows became viewable at all.
            # Parsed with the library's own helpers so the web app and the CLI
            # read a sealed.csv identically.
            price=_parse_sealed_money(row.get("Price")),
            price_date=_parse_sealed_date(row.get("Price date")),
            source=(row.get("Source") or "").strip(),
            cost_basis=_parse_sealed_money(row.get("Cost basis")),
            notes=(row.get("Notes") or "").strip(),
            line=index,
        ))

    resolved, issues = resolve(holdings, load_catalog())
    problems: Dict[int, List[str]] = {}
    for issue in issues:
        if issue.holding is not None:
            problems.setdefault(issue.holding.line, []).append(issue.code)

    staged = []
    for index, holding in enumerate(resolved):
        codes = problems.get(holding.line, [])
        staged.append({
            "raw": rows[index] if index < len(rows) else {},
            "parsed": _sealed_fields(holding),
            "issues": codes,
            "state": "pending" if _blocking(codes) else "resolved",
        })
    return staged


#: Codes that must be dealt with before a commit. Everything else is advisory —
#: a missing price or a non-English card is worth knowing, not worth blocking.
BLOCKING = {"unmatched", "ambiguous", "no-name", "bad-quantity"}


def _blocking(codes: Sequence[str]) -> bool:
    return bool(set(codes) & BLOCKING)


def _card_fields(card: Card) -> dict:
    return {
        "identity": "|".join(card.identity),
        "title": card.title,
        "edition": card.edition,
        "set_name": card.set_name,
        "collector_number": card.collector_number,
        "rarity": card.rarity,
        "foil": 1 if card.foil else 0,
        "finish": card.finish,
        "quantity": card.quantity,
        "price_cents": to_cents(card.market_price),
        "condition": card.condition,
        "language": card.language,
        "scryfall_id": card.scryfall_id,
        "manabox_id": card.manabox_id,
        "sources": "|".join(card.sources),
        "added_at": card.added.isoformat() if card.added else None,
    }


def _sealed_fields(holding: SealedHolding) -> dict:
    deck = holding.deck
    return {
        "identity": holding.identity,
        "mtgjson_uuid": deck.uuid if deck else "",
        "raw_name": holding.raw_name,
        "product_name": deck.name if deck else "",
        "set_code": holding.set_code,
        "set_name": deck.set_name if deck else "",
        "release_year": holding.year,
        "quantity": holding.quantity,
        "condition": holding.condition,
        "price_cents": to_cents(holding.price),
        "price_date": holding.price_date.isoformat() if holding.price_date else None,
        "price_source": holding.source,
        "cost_basis_cents": to_cents(holding.cost_basis),
        "purchase_url": deck.tcgplayer_url if deck else "",
        "notes": holding.notes,
        "resolved": 1 if holding.resolved else 0,
        "candidates": [f"{d.set_code} ({d.year})" for d in holding.candidates],
    }


# --- reading back -------------------------------------------------------------


def issues_for(conn: sqlite3.Connection, import_id: int) -> Dict[str, List[dict]]:
    """Staged rows grouped by issue code, for the doctor screen."""
    grouped: Dict[str, List[dict]] = {}
    for row in conn.execute(
        "SELECT * FROM staged_rows WHERE import_id = ? ORDER BY line_no", (import_id,)
    ):
        for code in json.loads(row["issues"]):
            grouped.setdefault(code, []).append({
                "id": row["id"],
                "line_no": row["line_no"],
                "parsed": json.loads(row["parsed"]),
                "resolution": json.loads(row["resolution"]),
                "state": row["state"],
                "blocking": code in BLOCKING,
            })
    return grouped


def blocking_count(conn: sqlite3.Connection, import_id: int) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM staged_rows "
        "WHERE import_id = ? AND state = 'pending'",
        (import_id,),
    ).fetchone()["n"]


# --- commit -------------------------------------------------------------------


def commit_import(conn: sqlite3.Connection, import_id: int) -> dict:
    """Apply a staged import to the canonical tables. One transaction, one undo.

    Quantities **add** for a card already held, because a second binder export
    is more of the same collection rather than a replacement. The price of the
    more recent scan wins, matching `aggregate.merge`.
    """
    record = conn.execute(
        "SELECT * FROM imports WHERE id = ?", (import_id,)
    ).fetchone()
    if record is None:
        raise LookupError(f"no import {import_id}")
    if record["status"] != "staged":
        raise ValueError(f"import {import_id} is already {record['status']}")

    pending = blocking_count(conn, import_id)
    if pending:
        raise ValueError(
            f"{pending} row(s) still need a decision. Resolve them on the review "
            f"screen, or skip them, before committing."
        )

    table = "holdings" if record["kind"] == "singles" else "sealed"
    staged = conn.execute(
        "SELECT * FROM staged_rows WHERE import_id = ? AND state != 'skipped' "
        "ORDER BY line_no",
        (import_id,),
    ).fetchall()

    # Snapshot the import row before its status changes.
    import_before = ops.snapshot_rows(conn, "imports", [import_id])

    before_rows: List[Dict[str, Any]] = []
    created_ids: List[int] = []
    added = updated = 0

    for row in staged:
        fields = json.loads(row["parsed"])
        fields.update(json.loads(row["resolution"]) or {})
        fields.pop("candidates", None)

        existing = conn.execute(
            f"SELECT * FROM {table} WHERE identity = ?", (fields["identity"],)
        ).fetchone()

        if existing is None:
            created_ids.append(_insert(conn, table, fields, import_id))
            added += 1
        else:
            # Capture the row as it is *now*, before `_merge_into` changes it.
            # Snapshotting after the loop would record the post-update state and
            # silently make the import unreversible — quantities would stay
            # merged after an undo.
            before_rows.append(dict(existing))
            _merge_into(conn, table, existing, fields, import_id)
            updated += 1

    conn.execute(
        "UPDATE imports SET status = 'committed', committed_at = ? WHERE id = ?",
        (now(), import_id),
    )

    ops.record(
        conn,
        "import_commit",
        f"Imported {record['filename']} — {added} new, {updated} updated",
        before={table: before_rows, "imports": import_before},
        created={table: created_ids},
        affected=added + updated,
    )
    return {"added": added, "updated": updated, "kind": record["kind"]}


def _insert(conn: sqlite3.Connection, table: str, fields: dict, import_id: int) -> int:
    payload = dict(fields)
    payload["source_import_id"] = import_id
    payload["created_at"] = payload["updated_at"] = now()
    columns = [c for c in payload if c in _columns(conn, table)]
    placeholders = ",".join("?" for _ in columns)
    cursor = conn.execute(
        f"INSERT INTO {table} ({','.join(columns)}) VALUES ({placeholders})",
        tuple(payload[c] for c in columns),
    )
    return cursor.lastrowid


def _merge_into(
    conn: sqlite3.Connection, table: str, existing, fields: dict, import_id: int
) -> None:
    """Add quantity; take the newer scan's price."""
    quantity = existing["quantity"] + int(fields.get("quantity") or 0)

    price = existing["price_cents"]
    incoming = fields.get("price_cents")
    if incoming is not None:
        newer = True
        if table == "holdings":
            old_at, new_at = existing["added_at"], fields.get("added_at")
            if old_at and new_at:
                newer = new_at >= old_at
        if newer or price is None:
            price = incoming

    conn.execute(
        f"UPDATE {table} SET quantity = ?, price_cents = ?, "
        f"source_import_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
        (quantity, price, import_id, now(), existing["id"]),
    )


def _columns(conn: sqlite3.Connection, table: str) -> set:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def discard_import(conn: sqlite3.Connection, import_id: int) -> None:
    """Throw a staged import away. Canonical data was never touched."""
    conn.execute(
        "UPDATE imports SET status = 'discarded' WHERE id = ? AND status = 'staged'",
        (import_id,),
    )
    conn.execute("DELETE FROM staged_rows WHERE import_id = ?", (import_id,))
