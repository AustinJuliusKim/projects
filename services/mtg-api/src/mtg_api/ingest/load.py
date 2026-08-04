"""Database writes for the ingest: batched hash-guarded upserts, guarded
removals, rulings reload, and ingest_runs bookkeeping. Counts come back from
RETURNING (xmax = 0), which is true for freshly inserted rows; rows whose
content_hash is unchanged are filtered by the DO UPDATE WHERE clause and cost
nothing."""

from collections.abc import Iterable, Iterator
from datetime import datetime
from typing import Any

import psycopg
from psycopg import sql
from psycopg.types.json import Json

BATCH_SIZE = 500

# Abort removals when a bulk file looks truncated: fewer than this fraction of
# the currently-live rows seen means something is wrong with the download.
MIN_SEEN_RATIO = 0.9

CARD_COLS = [
    "oracle_id",
    "name",
    "mana_cost",
    "mana_value",
    "type_line",
    "oracle_text",
    "colors",
    "color_identity",
    "keywords",
    "power",
    "toughness",
    "loyalty",
    "defense",
    "produced_mana",
    "layout",
    "legalities",
    "card_faces",
    "reserved",
    "edhrec_rank",
    "content_hash",
]
CARD_JSON_COLS = {"legalities", "card_faces"}

PRINTING_COLS = [
    "id",
    "oracle_id",
    "set_code",
    "collector_number",
    "rarity",
    "lang",
    "released_at",
    "artist",
    "finishes",
    "promo",
    "digital",
    "image_small",
    "image_normal",
    "image_status",
    "content_hash",
]

# Set on INSERT so fresh rows don't need a second write, but excluded from the
# ON CONFLICT update (and from content_hash) — price changes on existing rows
# go through update_prices with its IS DISTINCT FROM guard.
PRICE_COLS = ["price_usd", "price_usd_foil", "price_eur", "price_tix"]


def chunked(rows: Iterable[dict[str, Any]], size: int = BATCH_SIZE) -> Iterator[list[dict]]:
    batch: list[dict] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _upsert_batch(
    conn: psycopg.Connection,
    table: str,
    cols: list[str],
    conflict_col: str,
    update_where: str,
    batch: list[dict[str, Any]],
    json_cols: set[str] = frozenset(),
    extra_set: str = "",
    insert_only_cols: Iterable[str] = (),
) -> tuple[int, int]:
    """One multi-row INSERT ... ON CONFLICT DO UPDATE for a batch.
    Returns (inserted, updated); hash-unchanged rows are neither."""
    skip_update = {conflict_col, *insert_only_cols}
    update_cols = [c for c in cols if c not in skip_update]
    row_ph = sql.SQL("({})").format(sql.SQL(", ").join(sql.Placeholder() for _ in cols))
    query = sql.SQL(
        "INSERT INTO {table} ({cols}) VALUES {values} "
        "ON CONFLICT ({conflict}) DO UPDATE SET {sets}{extra}, updated_at = now() "
        "WHERE {where} RETURNING (xmax = 0) AS inserted"
    ).format(
        table=sql.Identifier(table),
        cols=sql.SQL(", ").join(sql.Identifier(c) for c in cols),
        values=sql.SQL(", ").join(row_ph for _ in batch),
        conflict=sql.Identifier(conflict_col),
        sets=sql.SQL(", ").join(
            sql.SQL("{c} = excluded.{c}").format(c=sql.Identifier(c)) for c in update_cols
        ),
        extra=sql.SQL(extra_set),
        where=sql.SQL(update_where),
    )
    params: list[Any] = []
    for row in batch:
        params.extend(
            Json(row[c]) if c in json_cols and row[c] is not None else row[c] for c in cols
        )
    returned = conn.execute(query, params).fetchall()
    inserted = sum(1 for (is_insert,) in returned if is_insert)
    return inserted, len(returned) - inserted


def upsert_cards(conn: psycopg.Connection, batch: list[dict[str, Any]]) -> tuple[int, int]:
    # `OR cards.is_removed` (plus the is_removed reset) revives a previously
    # soft-deleted card that reappears with an unchanged content hash.
    return _upsert_batch(
        conn,
        "cards",
        CARD_COLS,
        "oracle_id",
        "cards.content_hash IS DISTINCT FROM excluded.content_hash OR cards.is_removed",
        batch,
        json_cols=CARD_JSON_COLS,
        extra_set=", is_removed = false",
    )


def upsert_printings(conn: psycopg.Connection, batch: list[dict[str, Any]]) -> tuple[int, int]:
    return _upsert_batch(
        conn,
        "printings",
        PRINTING_COLS + PRICE_COLS,
        "id",
        "printings.content_hash IS DISTINCT FROM excluded.content_hash",
        batch,
        insert_only_cols=PRICE_COLS,
    )


def upsert_sets(conn: psycopg.Connection, rows: list[dict[str, Any]]) -> None:
    """Sets are tiny; upsert whatever the card stream mentioned. released_at
    keeps the earliest printing date seen (LEAST ignores NULLs)."""
    if not rows:
        return
    conn.cursor().executemany(
        "INSERT INTO sets (code, name, set_type, released_at) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (code) DO UPDATE SET name = excluded.name, "
        "set_type = excluded.set_type, "
        "released_at = LEAST(sets.released_at, excluded.released_at)",
        [(r["code"], r["name"], r["set_type"], r["released_at"]) for r in rows],
    )


def update_prices(conn: psycopg.Connection, batch: list[dict[str, Any]]) -> int:
    """Price columns update outside the content hash, guarded by IS DISTINCT
    FROM so unchanged prices produce no dead tuples. Returns rows changed."""
    values = sql.SQL(", ").join(sql.SQL("(%s, %s, %s, %s, %s)") for _ in batch)
    query = sql.SQL(
        "UPDATE printings p SET price_usd = v.usd::numeric, "
        "price_usd_foil = v.usd_foil::numeric, price_eur = v.eur::numeric, "
        "price_tix = v.tix::numeric "
        "FROM (VALUES {values}) AS v(id, usd, usd_foil, eur, tix) "
        "WHERE p.id = v.id::uuid AND "
        "(p.price_usd, p.price_usd_foil, p.price_eur, p.price_tix) IS DISTINCT FROM "
        "(v.usd::numeric, v.usd_foil::numeric, v.eur::numeric, v.tix::numeric)"
    ).format(values=values)
    params: list[Any] = []
    for row in batch:
        params.extend(
            [row["id"], row["price_usd"], row["price_usd_foil"], row["price_eur"], row["price_tix"]]
        )
    cur = conn.execute(query, params)
    return cur.rowcount


class TruncatedFileError(RuntimeError):
    pass


def _seen_guard(kind: str, seen: int, existing: int) -> None:
    if existing and seen < MIN_SEEN_RATIO * existing:
        raise TruncatedFileError(
            f"refusing {kind} removals: bulk file contains {seen} rows but the "
            f"database has {existing} live rows — download looks truncated"
        )


def apply_card_removals(conn: psycopg.Connection, seen_oracle_ids: set[str]) -> int:
    """Soft-delete cards absent from the bulk file. Guarded against truncated
    downloads; runs in its own transaction."""
    with conn.transaction():
        (existing,) = conn.execute("SELECT count(*) FROM cards WHERE NOT is_removed").fetchone()
        _seen_guard("card", len(seen_oracle_ids), existing)
        conn.execute("CREATE TEMP TABLE seen_cards (oracle_id uuid PRIMARY KEY) ON COMMIT DROP")
        conn.cursor().executemany(
            "INSERT INTO seen_cards (oracle_id) VALUES (%s)",
            [(oid,) for oid in seen_oracle_ids],
        )
        cur = conn.execute(
            "UPDATE cards SET is_removed = true, updated_at = now() "
            "WHERE NOT is_removed AND NOT EXISTS "
            "(SELECT 1 FROM seen_cards s WHERE s.oracle_id = cards.oracle_id)"
        )
        return cur.rowcount


def apply_printing_removals(conn: psycopg.Connection, seen_ids: set[str]) -> int:
    """Hard-delete printings absent from the bulk file (cards keep history;
    printings are fully re-derivable from the next ingest). Same guard."""
    with conn.transaction():
        (existing,) = conn.execute("SELECT count(*) FROM printings").fetchone()
        _seen_guard("printing", len(seen_ids), existing)
        conn.execute("CREATE TEMP TABLE seen_printings (id uuid PRIMARY KEY) ON COMMIT DROP")
        conn.cursor().executemany(
            "INSERT INTO seen_printings (id) VALUES (%s)", [(i,) for i in seen_ids]
        )
        cur = conn.execute(
            "DELETE FROM printings WHERE NOT EXISTS "
            "(SELECT 1 FROM seen_printings s WHERE s.id = printings.id)"
        )
        return cur.rowcount


def reload_rulings(conn: psycopg.Connection, rows: Iterable[dict[str, Any]]) -> int:
    """Truncate-and-reload in one transaction (~70k small rows; diffing isn't
    worth it). Returns rows loaded."""
    total = 0
    with conn.transaction():
        conn.execute("DELETE FROM rulings")
        for batch in chunked(rows):
            conn.cursor().executemany(
                "INSERT INTO rulings (oracle_id, published_at, comment, comment_hash) "
                "VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                [
                    (r["oracle_id"], r["published_at"], r["comment"], r["comment_hash"])
                    for r in batch
                ],
            )
            total += len(batch)
    return total


def existing_oracle_ids(conn: psycopg.Connection) -> set[str]:
    return {str(row[0]) for row in conn.execute("SELECT oracle_id FROM cards")}


def last_success_bulk_updated_at(conn: psycopg.Connection, source: str) -> datetime | None:
    row = conn.execute(
        "SELECT bulk_updated_at FROM ingest_runs WHERE source = %s AND status = 'ok' "
        "ORDER BY id DESC LIMIT 1",
        (source,),
    ).fetchone()
    return row[0] if row else None


def start_run(conn: psycopg.Connection, source: str, bulk_updated_at: datetime) -> int:
    (run_id,) = conn.execute(
        "INSERT INTO ingest_runs (source, bulk_updated_at) VALUES (%s, %s) RETURNING id",
        (source, bulk_updated_at),
    ).fetchone()
    conn.commit()
    return run_id


def finish_run(
    conn: psycopg.Connection,
    run_id: int,
    status: str,
    counts: dict[str, int] | None = None,
    error: str | None = None,
) -> None:
    counts = counts or {}
    conn.execute(
        "UPDATE ingest_runs SET finished_at = now(), status = %s, error = %s, "
        "rows_inserted = %s, rows_updated = %s, rows_removed = %s WHERE id = %s",
        (
            status,
            error,
            counts.get("inserted"),
            counts.get("updated"),
            counts.get("removed"),
            run_id,
        ),
    )
    conn.commit()
