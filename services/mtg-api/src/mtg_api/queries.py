"""Hand-written SQL for the read API (no ORM, repo rule). Every card query
filters out soft-deleted rows. `rep` is the representative printing used for
card images: newest paper printing with an image, falling back to digital."""

from typing import Any

import psycopg

CARD_COLS = (
    "c.oracle_id, c.name, c.mana_cost, c.mana_value, c.type_line, c.oracle_text, "
    "c.colors, c.color_identity, c.keywords, c.power, c.toughness, c.loyalty, "
    "c.defense, c.produced_mana, c.layout, c.legalities, c.card_faces, c.reserved, "
    "c.edhrec_rank, rep.image_small, rep.image_normal"
)

REP_IMAGE_JOIN = (
    "LEFT JOIN LATERAL ("
    "  SELECT p.image_small, p.image_normal FROM printings p"
    "  WHERE p.oracle_id = c.oracle_id AND p.image_normal IS NOT NULL"
    "  ORDER BY p.digital ASC, p.released_at DESC NULLS LAST LIMIT 1"
    ") rep ON true"
)

CARD_FROM = f"FROM cards c {REP_IMAGE_JOIN} WHERE NOT c.is_removed"


def card_by_id(conn: psycopg.Connection, oracle_id: str) -> dict[str, Any] | None:
    return conn.execute(
        f"SELECT {CARD_COLS} {CARD_FROM} AND c.oracle_id = %s", (oracle_id,)
    ).fetchone()


def card_by_exact_name(conn: psycopg.Connection, name: str) -> dict[str, Any] | None:
    # Names are not unique (Unfinity variants share one name across oracle
    # ids) — return the best-known one, like Scryfall's named endpoint.
    return conn.execute(
        f"SELECT {CARD_COLS} {CARD_FROM} AND lower(c.name) = lower(%s) "
        "ORDER BY c.edhrec_rank ASC NULLS LAST LIMIT 1",
        (name,),
    ).fetchone()


def card_by_fuzzy_name(conn: psycopg.Connection, name: str) -> dict[str, Any] | None:
    return conn.execute(
        f"SELECT {CARD_COLS} {CARD_FROM} AND similarity(c.name, %s) >= 0.25 "
        "ORDER BY similarity(c.name, %s) DESC, c.edhrec_rank ASC NULLS LAST LIMIT 1",
        (name, name),
    ).fetchone()


def random_card(conn: psycopg.Connection) -> dict[str, Any] | None:
    # ORDER BY random() over ~35k rows is ~10ms — fine at this traffic.
    return conn.execute(f"SELECT {CARD_COLS} {CARD_FROM} ORDER BY random() LIMIT 1").fetchone()


ORDERINGS = {
    "name": "c.name ASC",
    "mv": "c.mana_value ASC NULLS LAST, c.name ASC",
    "edhrec": "c.edhrec_rank ASC NULLS LAST, c.name ASC",
}


def search_cards(
    conn: psycopg.Connection,
    *,
    q: str | None,
    color: str | None,
    identity: str | None,
    type_: str | None,
    keyword: str | None,
    mv: float | None,
    mv_lte: float | None,
    mv_gte: float | None,
    format_: str | None,
    order: str,
    page: int,
    page_size: int,
) -> tuple[int, list[dict[str, Any]]]:
    """Returns (total, rows). Filter semantics: `color` = card's colors
    contain all given; `identity` = color identity fits within the given set
    (commander sense, so identity=G finds mono-green and colorless)."""
    where = ["NOT c.is_removed"]
    params: list[Any] = []
    if q:
        where.append("c.search_tsv @@ websearch_to_tsquery('english', %s)")
        params.append(q)
    if color:
        where.append("c.colors @> %s")
        params.append([ch for ch in color.upper() if ch != "C"])
    if identity is not None:
        where.append("c.color_identity <@ %s")
        params.append([ch for ch in identity.upper() if ch != "C"])
    if type_:
        where.append("c.type_line ILIKE %s")
        params.append(f"%{type_}%")
    if keyword:
        where.append("%s ILIKE ANY (c.keywords)")
        params.append(keyword)
    if mv is not None:
        where.append("c.mana_value = %s")
        params.append(mv)
    if mv_lte is not None:
        where.append("c.mana_value <= %s")
        params.append(mv_lte)
    if mv_gte is not None:
        where.append("c.mana_value >= %s")
        params.append(mv_gte)
    if format_:
        where.append("c.legalities ->> %s = 'legal'")
        params.append(format_.lower())

    sql = (
        f"SELECT {CARD_COLS}, count(*) OVER () AS total "
        f"FROM cards c {REP_IMAGE_JOIN} WHERE {' AND '.join(where)} "
        f"ORDER BY {ORDERINGS[order]} LIMIT %s OFFSET %s"
    )
    rows = conn.execute(sql, [*params, page_size, (page - 1) * page_size]).fetchall()
    total = rows[0]["total"] if rows else 0
    for row in rows:
        del row["total"]
    return total, rows


def autocomplete(conn: psycopg.Connection, q: str) -> list[str]:
    rows = conn.execute(
        "SELECT DISTINCT c.name, similarity(c.name, %s) AS sim FROM cards c "
        "WHERE NOT c.is_removed AND (c.name ILIKE %s OR c.name %% %s) "
        "ORDER BY sim DESC, c.name ASC LIMIT 20",
        (q, f"{q}%", q),
    ).fetchall()
    return [row["name"] for row in rows]


def rulings_for(conn: psycopg.Connection, oracle_id: str) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT published_at, comment FROM rulings WHERE oracle_id = %s "
        "ORDER BY published_at ASC, comment ASC",
        (oracle_id,),
    ).fetchall()


def printings_for(conn: psycopg.Connection, oracle_id: str) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT p.id, p.set_code, s.name AS set_name, p.collector_number, p.rarity, "
        "p.lang, p.released_at, p.artist, p.finishes, p.promo, p.digital, "
        "p.image_small, p.image_normal, p.price_usd, p.price_usd_foil, p.price_eur, "
        "p.price_tix "
        "FROM printings p JOIN sets s ON s.code = p.set_code "
        "WHERE p.oracle_id = %s ORDER BY p.released_at DESC NULLS LAST, p.set_code ASC",
        (oracle_id,),
    ).fetchall()


def all_sets(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT code, name, set_type, released_at, card_count, icon_svg_uri "
        "FROM sets ORDER BY released_at DESC NULLS LAST, code ASC"
    ).fetchall()


def set_by_code(conn: psycopg.Connection, code: str) -> dict[str, Any] | None:
    return conn.execute(
        "SELECT code, name, set_type, released_at, card_count, icon_svg_uri "
        "FROM sets WHERE code = %s",
        (code.lower(),),
    ).fetchone()
