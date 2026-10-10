"""End to end against a real OpenSearch (TEST_OPENSEARCH_URL) and the test
database: build a small catalog, rebuild listings, search through the API,
reserve the last copy and watch it leave stock search after a drain, cancel
and watch it come back. Every index is `itest_<uuid>_*` (TCG_SEARCH_PREFIX)
and deleted afterwards; the live `catalog` / `listings` aliases are never
touched. Skipped without TEST_OPENSEARCH_URL and TEST_DATABASE_URL."""

import os
import uuid

import psycopg
import pytest
from psycopg.rows import dict_row
from tcg_search.catalog.build import build as build_catalog
from tcg_search.client import OpenSearch

from conftest import TEST_DATABASE_URL, headers, public_headers, requires_db
from fake_opensearch import card_row, printing_row
from tcg_pos_api.search import get_search
from tcg_pos_api.search import listings as L

TEST_OPENSEARCH_URL = os.environ.get("TEST_OPENSEARCH_URL")
requires_os = pytest.mark.skipif(not TEST_OPENSEARCH_URL,
                                 reason="TEST_OPENSEARCH_URL not set (local OpenSearch on :9200)")
pytestmark = [requires_db, requires_os]


@pytest.fixture
def cluster(client, monkeypatch):
    prefix = f"itest_{uuid.uuid4().hex[:12]}_"
    monkeypatch.setenv("TCG_SEARCH_PREFIX", prefix)
    os_ = OpenSearch(TEST_OPENSEARCH_URL)

    def _search():
        c = OpenSearch(TEST_OPENSEARCH_URL)
        try:
            yield c
        finally:
            c.close()

    client.app.dependency_overrides[get_search] = _search
    try:
        yield os_, prefix
    finally:
        client.app.dependency_overrides.pop(get_search, None)
        for row in os_.list_indices(f"{prefix}*"):
            assert row["index"].startswith("itest_")
            os_.delete_index(row["index"], missing_ok=True)
        os_.close()


def test_rebuild_drain_and_search_end_to_end(client, cluster, make_shop, admin_conn):
    os_, prefix = cluster
    p = {k: uuid.uuid4() for k in ("bolt", "bolt_old", "shock", "counter")}
    rows = [
        card_row("Lightning Bolt", [printing_row(p["bolt"], "m11", "149", rarity="common"),
                                    printing_row(p["bolt_old"], "lea", "161",
                                                 released="1993-08-05", rarity="common")],
                 rank=10),
        card_row("Shock", [printing_row(p["shock"], "m19", "156")], rank=50),
        card_row("Counterspell", [printing_row(p["counter"], "mh2", "267",
                                               rarity="uncommon")],
                 colors=["U"], color_identity=["U"], mana_cost="{U}{U}", rank=20),
    ]
    build_catalog(os_, rows, alias=f"{prefix}catalog", swap=True)
    alias = f"{prefix}listings"

    a, b = make_shop("A"), make_shop("B")
    bolt_item = a["stock"](1, 150, printing_id=p["bolt"])  # the last copy
    a["stock"](3, 1200, printing_id=p["bolt_old"], condition="LP")
    a["stock"](2, 900, printing_id=p["counter"])
    b["stock"](4, 25, printing_id=p["shock"])

    with psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as db, \
            psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as reader:
        src = L.Sources(os_=os_, reader=reader, catalog_index=f"{prefix}catalog")
        with L.writer_lock(db):
            first = L.rebuild(db, src, alias=alias)
            L.drain(db, src, alias=alias)
        assert os_.get_alias(alias) == [first.index]

        def search(shop, **params):
            resp = client.get(f"{shop['base']}/search", params=params)
            assert resp.status_code == 200, resp.text
            return resp.json()

        def drain():
            with L.writer_lock(db):
                L.drain(db, src, alias=alias)
            os_.refresh(alias)

        os_.refresh(alias)
        out = search(a, q="bolt")
        assert [r["name"] for r in out["results"]] == ["Lightning Bolt"]
        hit = out["results"][0]
        assert hit["in_stock"] == 4 and hit["price_cents"] == 150
        assert sorted(o["set"] for o in hit["offers"]) == ["lea", "m11"]
        # Tenant isolation: A doesn't sell Shock, B does.
        assert search(a, q="shock")["total"] == 0
        assert search(b, q="shock")["results"][0]["name"] == "Shock"
        # Facets narrow and count cards.
        out = search(a, q="", colors="U")
        assert [r["name"] for r in out["results"]] == ["Counterspell"]
        assert {f["value"]: f["count"] for f in search(a)["facets"]["set"]} == {
            "lea": 1, "m11": 1, "mh2": 1}
        # Catalog mode shows everything, annotated with this store's stock.
        out = search(a, q="shock", mode="catalog")
        assert out["results"][0]["name"] == "Shock" and out["results"][0]["in_stock"] == 0
        out = search(a, q="counterspell", mode="catalog")
        assert out["results"][0]["in_stock"] == 2
        assert out["results"][0]["store_price_cents"] == 900
        # Autocomplete: in stock first.
        sugg = client.get(f"{a['base']}/autocomplete", params={"q": "ligh"}).json()
        assert sugg[0]["name"] == "Lightning Bolt" and sugg[0]["in_stock"] is True

        # Reserve the m11 copy: the m11 offer leaves, the card stays (lea LP).
        order = client.post(f"{a['base']}/orders", headers=public_headers(), json={
            "idempotency_key": uuid.uuid4().hex,
            "customer": {"name": "Pat", "email": "pat@example.com"},
            "lines": [{"inventory_item_id": str(bolt_item), "qty": 1}],
        })
        assert order.status_code == 201, order.text
        drain()
        hit = search(a, q="bolt")["results"][0]
        assert [o["set"] for o in hit["offers"]] == ["lea"] and hit["in_stock"] == 3
        # Sell out the card entirely: it leaves stock search.
        admin_conn.execute("UPDATE inventory_item SET qty = 0 WHERE printing_id = %s",
                           (p["bolt_old"],))
        drain()
        assert search(a, q="bolt")["total"] == 0
        # Staff cancel puts the m11 copy back.
        resp = client.post(f"/v1/web-orders/{order.json()['id']}/cancel",
                           headers=headers(a["tenant"]))
        assert resp.status_code == 200, resp.text
        drain()
        hit = search(a, q="bolt")["results"][0]
        assert [o["set"] for o in hit["offers"]] == ["m11"] and hit["in_stock"] == 1

        # A second rebuild swaps atomically and keeps the first for rollback.
        with L.writer_lock(db):
            second = L.rebuild(db, src, alias=alias)
        assert os_.get_alias(alias) == [second.index]
        assert {r["index"] for r in os_.list_indices(f"{alias}-*")} == {first.index,
                                                                       second.index}
        os_.refresh(alias)
        assert search(a, q="bolt")["total"] == 1

    # Card page: card from the catalog index, offers live from Postgres.
    card = client.get(f"{a['base']}/cards/{rows[0]['oracle_id']}").json()
    assert card["source"] == "index" and card["card"]["name"] == "Lightning Bolt"
    assert [pr["set_code"] for pr in card["card"]["printings"]] == ["m11", "lea"]
    assert list(card["offers"]) == [str(p["bolt"])]
