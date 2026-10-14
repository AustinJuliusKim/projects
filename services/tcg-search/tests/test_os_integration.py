"""Against a real OpenSearch (TEST_OPENSEARCH_URL): analyzer expectations
through _analyze, a catalog build/swap/search/rollback cycle from fixture
rows, and listings tenant isolation + required routing."""

import pytest

from conftest import requires_os
from fixtures_cards import sample_rows
from tcg_search import docs, mappings
from tcg_search.catalog import build as b
from tcg_search.query import SearchRequest, autocomplete, search

pytestmark = requires_os


@pytest.fixture(scope="module")
def analysis_index(os_client, prefix):
    name = f"{prefix}analysis"
    os_client.create_index(name, mappings.catalog_index_body())
    return name


@pytest.mark.parametrize(
    "analyzer, text, tokens",
    [
        ("name_index", "Lim-Dûl the Necromancer", ["limdul", "lim", "dul", "the", "necromancer"]),
        ("name_index", "Urza's Saga", ["urzas", "urza", "s", "saga"]),
        ("name_index", "Fire // Ice", ["fire", "ice"]),
        ("name_index", "Æther Vial", ["aether", "vial"]),
        ("name_search", "lim-dul", ["lim", "dul"]),
        ("name_plain", "Kiki-Jiki, Mirror Breaker", ["kiki", "jiki", "mirror", "breaker"]),
        ("rules", "{W/U}, {T}: Add {G}{2/W}{W/U/P}.", ["mswu", "mst", "add", "msg", "ms2w",
                                                        "mswup"]),
        ("rules", "Draw cards.", ["draw", "card"]),
        ("rules_search", "etb", ["enter"]),
        ("rules_search", "ltb", ["leav", "the", "battlefield"]),
        ("rules_plain", "Whenever it enters", ["whenever", "it", "enters"]),
        ("plain", "Legendary Creature — Elf Druids", ["legendary", "creature", "elf", "druid"]),
    ],
)
def test_analyzers(os_client, analysis_index, analyzer, text, tokens):
    assert os_client.analyze(analysis_index, text, analyzer=analyzer) == tokens


@pytest.mark.parametrize(
    "text, token",
    [("Fire // Ice", "fireice"), ("fire ice", "fireice"), ("Lim-Dûl's Vault", "limdulsvault"),
     ("Jötun Grunt", "jotungrunt")],
)
def test_compact_normalizer(os_client, analysis_index, text, token):
    from tcg_search.cardtext import compact

    assert os_client.analyze(analysis_index, text, field="names_exact") == [token]
    assert compact(text) == token  # the Python twin agrees


@pytest.fixture(scope="module")
def catalog(os_client, prefix):
    alias = f"{prefix}catalog"
    first = b.build(os_client, sample_rows(), alias=alias, swap=True)
    second = b.build(os_client, sample_rows(), alias=alias, swap=True)
    return {"alias": alias, "first": first.index, "second": second.index}


def _names(res):
    return [r["name"] for r in res["results"]]


def _search(os_client, catalog, q, **kw):
    return search(os_client, SearchRequest(q=q, **kw), catalog_index=catalog["alias"])


def test_alias_swap_and_status(os_client, catalog):
    assert os_client.get_alias(catalog["alias"]) == [catalog["second"]]
    st = b.status(os_client, catalog["alias"])
    assert [v["index"] for v in st["versions"]] == [catalog["first"], catalog["second"]]
    assert st["versions"][1]["meta"]["docs"] == 7


@pytest.mark.parametrize(
    "q, first",
    [
        ("bolt", "Lightning Bolt"),
        ("lightning bolt", "Lightning Bolt"),
        ("goyf", "Tarmogoyf"),
        ("tarmogyof", "Tarmogoyf"),
        ("fire ice", "Fire // Ice"),
        ("ice", "Fire // Ice"),
        ("lim dul", "Lim-Dûl's Vault"),
        ("limdul", "Lim-Dûl's Vault"),
        ("t:dragon c:r", "Shivan Dragon"),
        ("s:alpha r:rare", "Shivan Dragon"),
        ('o:"divided as you choose"', "Fire // Ice"),
    ],
)
def test_search_ranks(os_client, catalog, q, first):
    assert _names(_search(os_client, catalog, q))[0] == first


def test_digital_only_hidden_by_default(os_client, catalog):
    assert "Digital Only Thing" not in _names(_search(os_client, catalog, ""))
    assert _names(_search(os_client, catalog, "is:digital")) == ["Digital Only Thing"]


def test_cardname_substitution_keeps_text_queries_honest(os_client, catalog):
    # "lightning" appears in Bolt's rules text only as its own name.
    res = _search(os_client, catalog, "o:lightning")
    assert res["total"] == 0


def test_typo_corrected(os_client, catalog):
    res = _search(os_client, catalog, "tarmogyof")
    assert res["did_you_mean"] == "Tarmogoyf" and res["corrected"]


def test_facets_count_cards_and_price_sort(os_client, catalog):
    res = _search(os_client, catalog, "", facets={"set": ["lea"]}, sort="price_desc")
    assert _names(res) == ["Shivan Dragon", "Lightning Bolt"]
    sets = {f["value"]: f["count"] for f in res["facets"]["set"]}
    assert sets["lea"] == 2 and sets["m11"] == 1  # cards, not printings
    assert res["results"][1]["printings"][0]["set"] == "lea"  # inner hits honour the facet
    rarity = {f["value"]: f["count"] for f in res["facets"]["rarity"]}
    assert rarity == {"rare": 1, "common": 1}


def test_autocomplete(os_client, catalog):
    out = autocomplete(os_client, "lightn", catalog_index=catalog["alias"])
    assert out[0]["name"] == "Lightning Bolt" and out[0]["in_stock"] is False


def test_rollback(os_client, catalog):
    prev, target = b.rollback(os_client, catalog["alias"])
    assert (prev, target) == (catalog["second"], catalog["first"])
    assert os_client.get_alias(catalog["alias"]) == [catalog["first"]]
    b.swap(os_client, catalog["alias"])
    assert os_client.get_alias(catalog["alias"]) == [catalog["second"]]


def test_shrink_guard_live(os_client, catalog):
    with pytest.raises(b.BuildError, match="below 95%"):
        b.build(os_client, sample_rows()[:3], alias=catalog["alias"], swap=True)
    assert os_client.get_alias(catalog["alias"]) == [catalog["second"]]


# --- listings ----------------------------------------------------------------------


@pytest.fixture(scope="module")
def listings(os_client, prefix):
    name = f"{prefix}listings"
    os_client.create_index(name, mappings.listings_index_body())
    rows = {r["name"]: r for r in sample_rows()}
    offer = {"printing_id": "p1", "set_code": "m11", "finish": "nonfoil", "condition": "NM",
             "price_cents": 199, "available": 2}
    actions = []
    for tenant, cards in (("tenant-a", ["Lightning Bolt", "Tarmogoyf"]),
                          ("tenant-b", ["Lightning Bolt", "Bolt Bend"])):
        for c in cards:
            doc = docs.listing_doc(rows[c], tenant, [offer])
            actions.append(("index", {"_id": docs.listing_id(tenant, doc["oracle_id"]),
                                      "routing": tenant}, doc))
    res = os_client.bulk(actions, index=name, refresh=True)
    assert not res.errors
    return name


def test_listings_routing_is_required(os_client, listings):
    doc = docs.listing_doc(sample_rows()[0], "tenant-c", [
        {"printing_id": "p", "price_cents": 100, "available": 1}])
    res = os_client.bulk([("index", {"_id": "x"}, doc)], index=listings)
    assert res.failed == 1 and "routing" in str(res.errors[0]["error"])


def test_listings_are_tenant_isolated(os_client, listings):
    def names(tenant, q=""):
        res = search(os_client, SearchRequest(q=q, mode="stock", tenant_id=tenant),
                     listings_index=listings)
        return sorted(_names(res))

    assert names("tenant-a") == ["Lightning Bolt", "Tarmogoyf"]
    assert names("tenant-b") == ["Bolt Bend", "Lightning Bolt"]
    assert names("tenant-b", "goyf") == []
    assert names("nobody") == []


def test_listings_autocomplete_in_stock_first(os_client, catalog, listings):
    out = autocomplete(os_client, "bolt", tenant_id="tenant-b",
                       catalog_index=catalog["alias"], listings_index=listings)
    assert [(s["name"], s["in_stock"]) for s in out[:2]] == [
        ("Lightning Bolt", True), ("Bolt Bend", True)]


def test_auto_create_is_off(os_client, prefix):
    # The cluster must refuse writes to a missing index (OPS.md config).
    res = os_client.bulk([("index", {"_id": "1"}, {"a": 1})], index=f"{prefix}nope")
    assert res.failed == 1 and "index_not_found" in str(res.errors[0]["error"])
    assert os_client.get_index(f"{prefix}nope") is None
