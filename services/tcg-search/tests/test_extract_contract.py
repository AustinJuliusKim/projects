"""Contract test for catalog/extract.py against mtg-api's real schema
(TEST_CATALOG_DATABASE_URL: a scratch DB built by scripts/make_contract_db.sh
from mtg-api's migrations + fixtures — never mtg_dev). If mtg-api renames or
drops a column the extract reads, this fails here, not in the nightly job.

Price rows are inserted inside the test's transaction and rolled back."""

import pytest

from conftest import TEST_CATALOG_DATABASE_URL, requires_catalog_db
from tcg_search.catalog import extract
from tcg_search.docs import catalog_doc

pytestmark = requires_catalog_db


@pytest.fixture
def conn():
    with extract.connect(TEST_CATALOG_DATABASE_URL) as c:
        yield c
        c.rollback()


def _bolt_printing(conn):
    return conn.execute(
        "SELECT p.id FROM printings p JOIN cards c ON c.oracle_id = p.oracle_id "
        "WHERE c.name = 'Lightning Bolt' AND NOT p.digital ORDER BY p.released_at LIMIT 1"
    ).fetchone()["id"]


def _price(conn, printing_id, finish, source, column, cents, condition="NM"):
    sku = conn.execute(
        "INSERT INTO skus (printing_id, finish, condition) VALUES (%s, %s, %s) "
        "ON CONFLICT (game, printing_id, finish, condition, lang) DO UPDATE SET finish = "
        "EXCLUDED.finish RETURNING id",
        (printing_id, finish, condition),
    ).fetchone()["id"]
    snap = conn.execute(
        "INSERT INTO price_snapshots (snapshot_id, as_of, revision) "
        "VALUES ('2026-10-09.1', '2026-10-09', 1) ON CONFLICT (game, snapshot_id) "
        "DO UPDATE SET revision = 1 RETURNING seq"
    ).fetchone()["seq"]
    conn.execute(
        f"INSERT INTO price_current (sku_id, source_id, snapshot_seq, as_of, {column}) "
        "SELECT %s, id, %s, '2026-10-09', %s FROM price_sources WHERE code = %s",
        (sku, snap, cents, source),
    )


def test_extract_rows_build_docs(conn):
    rows = list(extract.iter_cards(conn))
    assert len(rows) == conn.execute(
        "SELECT count(*) AS n FROM cards WHERE NOT is_removed").fetchone()["n"]
    expected_keys = {
        "oracle_id", "name", "mana_cost", "mana_value", "type_line", "oracle_text", "colors",
        "color_identity", "keywords", "power", "toughness", "loyalty", "defense",
        "produced_mana", "layout", "legalities", "card_faces", "reserved", "edhrec_rank",
        "printings",
    }
    assert set(rows[0]) == expected_keys
    bolt = next(r for r in rows if r["name"] == "Lightning Bolt")
    assert len(bolt["printings"]) >= 3
    p = bolt["printings"][0]
    assert {"id", "set_code", "set_name", "set_type", "collector_number", "rarity", "lang",
            "released_at", "artist", "finishes", "promo", "digital", "image_small",
            "image_normal", "price_nonfoil_cents", "price_nonfoil_source"} <= set(p)
    # No price rows yet: null, never 0.
    assert all(x["price_nonfoil_cents"] is None for x in bolt["printings"])
    # Every row turns into a doc.
    docs_ = [catalog_doc(r) for r in rows]
    assert all(d["oracle_id"] and d["name"] for d in docs_)


def test_headline_price_lanes_and_preference(conn):
    pid = _bolt_printing(conn)
    # Scryfall alone: used.
    _price(conn, pid, "nonfoil", "scryfall_usd", "trend_cents", 210)
    bolt = next(r for r in extract.iter_cards(conn) if r["name"] == "Lightning Bolt")
    p = next(x for x in bolt["printings"] if x["id"] == str(pid))
    assert (p["price_nonfoil_cents"], p["price_nonfoil_source"]) == (210, "scryfall_usd")

    # TCGplayer present: preferred even when higher.
    _price(conn, pid, "nonfoil", "mtgjson_tcgplayer", "retail_cents", 250)
    # Licensed / qa-only lanes and non-NM conditions never leak.
    _price(conn, pid, "nonfoil", "justtcg", "retail_cents", 1)
    _price(conn, pid, "nonfoil", "tcgcsv", "retail_cents", 2)
    _price(conn, pid, "foil", "mtgjson_tcgplayer", "retail_cents", 3, condition="LP")
    # Card Kingdom is an open lane but not a headline source.
    _price(conn, pid, "foil", "mtgjson_cardkingdom", "retail_cents", 4)

    bolt = next(r for r in extract.iter_cards(conn) if r["name"] == "Lightning Bolt")
    p = next(x for x in bolt["printings"] if x["id"] == str(pid))
    assert (p["price_nonfoil_cents"], p["price_nonfoil_source"]) == (250, "mtgjson_tcgplayer")
    assert p["price_foil_cents"] is None
    doc = catalog_doc(bolt)
    assert (doc["price_cents"], doc["price_source"]) == (250, "mtgjson_tcgplayer")


def test_zero_price_is_null(conn):
    pid = _bolt_printing(conn)
    _price(conn, pid, "nonfoil", "mtgjson_tcgplayer", "retail_cents", 0)
    bolt = next(r for r in extract.iter_cards(conn) if r["name"] == "Lightning Bolt")
    p = next(x for x in bolt["printings"] if x["id"] == str(pid))
    assert p["price_nonfoil_cents"] is None


def test_latest_snapshot(conn):
    assert extract.latest_snapshot(conn) is None or "snapshot_id" in extract.latest_snapshot(conn)
