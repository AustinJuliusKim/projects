"""Public storefront search API (/v1/storefront/{slug}/search, /autocomplete,
/cards/{oracle_id}) against a fake OpenSearch (tests/fake_opensearch.py):
the tenant filter and routing on every listings request, request bodies,
responses passed through verbatim, the 503 paths, and card pages with live
offers from Postgres (mtg-api fallback when OpenSearch is down). Skipped
without TEST_DATABASE_URL (slug resolution needs the database)."""

import uuid

import pytest
from tcg_search.query import SearchRequest, search

from conftest import requires_db
from fake_opensearch import FakeOpenSearch, card_row, printing_row
from tcg_pos_api.search import get_search

pytestmark = requires_db


@pytest.fixture
def fake_os(client):
    fake = FakeOpenSearch()

    def _override():
        c = fake.client()
        try:
            yield c
        finally:
            c.close()

    client.app.dependency_overrides[get_search] = _override
    yield fake
    client.app.dependency_overrides.pop(get_search, None)


def listing_doc(tenant, oracle_id, name, *, in_stock=2, price=150):
    return {"oracle_id": str(oracle_id), "name": name, "tenant_id": str(tenant),
            "in_stock": in_stock, "price_cents": price, "type_line": "Instant",
            "offers": [{"printing_id": str(uuid.uuid4()), "set": "m11", "condition": "NM",
                        "finish": "nonfoil", "price_cents": price, "available": in_stock}]}


def raw_hits(*docs):
    return {"took": 4, "hits": {"total": {"value": len(docs)}, "hits": [
        {"_id": d["oracle_id"], "_score": 9.0, "_source": {k: v for k, v in d.items()
                                                            if k != "offers"},
         "matched_queries": ["exact"],
         "inner_hits": {"copies": {"hits": {"hits": [{"_source": o}
                                                     for o in d.get("offers", [])]}}}}
        for d in docs]}}


def main_search(fake):
    """The query-builder request (not a lookup the route makes on the side)."""
    return [r for r in fake.searches() if "aggs" in r["body"]]


# --- search ---------------------------------------------------------------------------


def test_stock_search_is_tenant_scoped_routed_and_verbatim(client, make_shop, fake_os):
    shop, other = make_shop("A"), make_shop("B")
    tenant = str(shop["tenant"]["id"])
    fake_os.search_response = raw_hits(listing_doc(tenant, uuid.uuid4(), "Lightning Bolt"))
    params = [("q", "bolt"), ("set", "mh2"), ("set", "ltr"), ("rarity", "rare"),
              ("sort", "price_asc"), ("page", "2"), ("page_size", "10")]
    resp = client.get(f"{shop['base']}/search", params=params,
                      headers={"X-Tenant-Id": str(other["tenant"]["id"])})  # forged: ignored
    assert resp.status_code == 200, resp.text

    (req,) = main_search(fake_os)
    assert req["index"] == "listings"
    assert req["params"] == {"routing": tenant}
    body = req["body"]
    assert body["query"]["bool"]["filter"][0] == {"term": {"tenant_id": tenant}}
    assert (body["from"], body["size"]) == (10, 10)
    post = body["post_filter"]["bool"]["filter"]
    nested_terms = post[-1]["nested"]["query"]["bool"]["filter"]
    assert {"terms": {"offers.set": ["mh2", "ltr"]}} in nested_terms
    assert {"terms": {"offers.rarity": ["rare"]}} in nested_terms
    # Every listings request this route made carried the slug's tenant.
    for r in fake_os.searches("listings"):
        assert r["params"] == {"routing": tenant}

    # The response is tcg_search's search() output, untouched.
    direct = search(fake_os.client(), SearchRequest(
        q="bolt", mode="stock", tenant_id=tenant, sort="price_asc", page=2, page_size=10,
        facets={"set": ["mh2", "ltr"], "rarity": ["rare"]}),
        catalog_index="catalog", listings_index="listings")
    assert resp.json() == direct
    assert resp.json()["results"][0]["name"] == "Lightning Bolt"
    assert set(resp.json()) == {"mode", "q", "total", "took_ms", "page", "page_size", "sort",
                                "results", "facets", "query", "warnings", "did_you_mean",
                                "corrected"}


def test_every_facet_param_reaches_the_query(client, make_shop, fake_os):
    shop = make_shop()
    params = [("set", "lea"), ("rarity", "mythic"), ("finish", "foil"), ("condition", "LP"),
              ("price", "100-500"), ("colors", "R"), ("colors", "G"), ("identity", "R"),
              ("types", "creature"), ("keywords", "flying"), ("format", "modern")]
    resp = client.get(f"{shop['base']}/search", params=params)
    assert resp.status_code == 200, resp.text
    clauses = {c["key"]: c["value"] for c in resp.json()["query"]["clauses"]}
    assert clauses == {"set": ["lea"], "rarity": ["mythic"], "finish": ["foil"],
                       "condition": ["LP"], "price": ["100-500"], "colors": ["R", "G"],
                       "identity": ["R"], "types": ["creature"], "keywords": ["flying"],
                       "format": ["modern"]}
    assert resp.json()["warnings"] == []


def test_catalog_mode_searches_catalog_and_annotates_in_stock(client, make_shop, fake_os):
    a, b = make_shop("A"), make_shop("B")
    ta, tb = str(a["tenant"]["id"]), str(b["tenant"]["id"])
    have, other, none = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    fake_os.listings = {
        f"{ta}:{have}": {"routing": ta, "doc": listing_doc(ta, have, "Bolt", in_stock=3,
                                                           price=175)},
        f"{tb}:{other}": {"routing": tb, "doc": listing_doc(tb, other, "Shock")},
    }
    fake_os.search_response = raw_hits(
        {"oracle_id": str(have), "name": "Bolt", "price_cents": 99},
        {"oracle_id": str(other), "name": "Shock", "price_cents": 10},
        {"oracle_id": str(none), "name": "Counterspell"},
    )
    resp = client.get(f"{a['base']}/search", params={"q": "x", "mode": "catalog"})
    assert resp.status_code == 200, resp.text
    (req,) = main_search(fake_os)
    assert req["index"] == "catalog" and req["params"] == {}
    (lookup,) = fake_os.searches("listings")
    assert lookup["params"] == {"routing": ta}
    assert lookup["body"]["query"]["bool"]["filter"][0] == {"term": {"tenant_id": ta}}
    got = [(r["name"], r["in_stock"], r["store_price_cents"], r["price_cents"] if
            "price_cents" in r else None) for r in resp.json()["results"]]
    # B's stock never shows up as A's; the catalog headline price is kept.
    assert got == [("Bolt", 3, 175, 99), ("Shock", 0, None, 10), ("Counterspell", 0, None, None)]
    assert resp.json()["mode"] == "catalog"


def test_unknown_slug_is_404_before_any_search(client, make_shop, fake_os):
    hidden = make_shop(published=False)
    for path in ("/v1/storefront/no-such-store/search", f"{hidden['base']}/search",
                 f"{hidden['base']}/autocomplete?q=bo",
                 f"{hidden['base']}/cards/{uuid.uuid4()}"):
        resp = client.get(path)
        assert resp.status_code == 404, path
        assert resp.json() == {"detail": "no such store"}
    assert fake_os.requests == []


def test_search_and_autocomplete_503_when_opensearch_is_down(client, make_shop, fake_os):
    shop = make_shop()
    fake_os.down = True
    for path in (f"{shop['base']}/search?q=bolt", f"{shop['base']}/search?mode=catalog",
                 f"{shop['base']}/autocomplete?q=bo"):
        resp = client.get(path)
        assert resp.status_code == 503, path
        assert resp.json() == {"detail": "search is temporarily unavailable"}


def test_search_503_when_index_not_built(client, make_shop, fake_os):
    shop = make_shop()
    fake_os.aliases["listings"] = None
    resp = client.get(f"{shop['base']}/search", params={"q": "bolt"})
    assert resp.status_code == 503
    assert resp.json() == {"detail": "search index is not built yet"}


def test_search_param_validation(client, make_shop, fake_os):
    shop = make_shop()
    for params in ({"page_size": 101}, {"page": 0}, {"mode": "everything"}, {"q": "x" * 501}):
        assert client.get(f"{shop['base']}/search", params=params).status_code == 422, params


def test_autocomplete_in_stock_first_tenant_scoped(client, make_shop, fake_os):
    shop = make_shop()
    tenant = str(shop["tenant"]["id"])
    o1, o2 = uuid.uuid4(), uuid.uuid4()
    fake_os.search_response = {"hits": {"hits": [
        {"_source": {"oracle_id": str(o1), "name": "Lightning Bolt"}},
        {"_source": {"oracle_id": str(o2), "name": "Lightning Helix"}},
    ]}}
    resp = client.get(f"{shop['base']}/autocomplete", params={"q": "lig", "size": 3})
    assert resp.status_code == 200, resp.text
    listings_req, catalog_req = fake_os.searches()
    assert listings_req["index"] == "listings" and listings_req["params"] == {"routing": tenant}
    assert listings_req["body"]["query"]["bool"]["filter"] == [{"term": {"tenant_id": tenant}}]
    assert catalog_req["index"] == "catalog"
    # Same names from both: the in-stock ones win, nothing repeats.
    assert resp.json() == [
        {"oracle_id": str(o1), "name": "Lightning Bolt", "in_stock": True},
        {"oracle_id": str(o2), "name": "Lightning Helix", "in_stock": True},
    ]


def test_api_prefix_is_accepted(client, make_shop, fake_os):
    shop = make_shop()
    assert client.get(f"/api{shop['base']}").status_code == 200
    assert client.get(f"/api{shop['base']}/search").status_code == 200


# --- card page --------------------------------------------------------------------------


def _bolt(fake):
    p_new, p_old, p_digital = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    row = card_row("Lightning Bolt", [
        printing_row(p_new, "m11", "149", released="2010-07-16"),
        printing_row(p_old, "lea", "161", released="1993-08-05", rarity="common"),
        printing_row(p_digital, "pmtg", "1", digital=True),
    ])
    fake.add_card(row)
    return row, p_new, p_old


def test_card_page_card_from_index_offers_live(client, make_shop, fake_os):
    shop = make_shop(holdback_copies=1)
    row, p_new, p_old = _bolt(fake_os)
    nm = shop["stock"](3, 150, printing_id=p_new)
    shop["stock"](1, 99, printing_id=p_new, condition="LP")  # held back
    shop["stock"](5, None, printing_id=p_old)  # unpriced
    resp = client.get(f"{shop['base']}/cards/{row['oracle_id']}")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["source"] == "index"
    card = out["card"]
    assert card["name"] == "Lightning Bolt" and card["oracle_text"] == \
        "Lightning Bolt does a thing."
    assert "score" not in card
    assert [p["set_code"] for p in card["printings"]] == ["m11", "lea"]  # paper, newest first
    assert set(card["printings"][0]) == {"id", "set_code", "set_name", "collector_number",
                                         "rarity", "finishes", "released_at", "lang",
                                         "image_small", "image_normal"}
    assert out["offers"] == {str(p_new): [{
        "inventory_item_id": str(nm), "printing_id": str(p_new), "game": "mtg",
        "condition": "NM", "finish": "nonfoil", "lang": "en", "price_cents": 150,
        "available": 2}]}


def test_card_page_falls_back_to_mtg_api_when_opensearch_is_down(
        client, make_shop, fake_os, fake_catalog):
    shop = make_shop()
    row, p_new, p_old = _bolt(FakeOpenSearch())
    fake_os.down = True
    oid = row["oracle_id"]
    fake_catalog.cards[oid] = {k: v for k, v in row.items() if k != "printings"}
    fake_catalog.card_printings[oid] = [
        {"id": str(p_old), "set_code": "lea", "set_name": "Alpha", "collector_number": "161",
         "rarity": "common", "lang": "en", "released_at": "1993-08-05", "digital": False,
         "finishes": ["nonfoil"], "image_small": "s", "image_normal": "n"},
        {"id": str(uuid.uuid4()), "set_code": "pmtg", "digital": True},
        {"id": str(p_new), "set_code": "m11", "released_at": "2010-07-16", "digital": False},
    ]
    item = shop["stock"](2, 300, printing_id=p_old)
    resp = client.get(f"{shop['base']}/cards/{oid}")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["source"] == "mtg-api"
    assert out["card"]["name"] == "Lightning Bolt"
    assert [p["set_code"] for p in out["card"]["printings"]] == ["m11", "lea"]
    assert [o["inventory_item_id"] for o in out["offers"][str(p_old)]] == [str(item)]


def test_card_page_404s(client, make_shop, fake_os, fake_catalog):
    shop = make_shop()
    assert client.get(f"{shop['base']}/cards/{uuid.uuid4()}").status_code == 404
    fake_os.down = True
    resp = client.get(f"{shop['base']}/cards/{uuid.uuid4()}")
    assert resp.status_code == 404 and resp.json() == {"detail": "no such card"}
    assert client.get(f"{shop['base']}/cards/not-a-uuid").status_code == 422
