"""The pure builder: whole-dict comparisons, the listings tenant wrap on
every path, facets, sorts and paging."""

import itertools
import json

import pytest

from tcg_search.query.build import (
    PRICE_BANDS,
    SORTS,
    SearchRequest,
    build_search,
    facet_names,
    paging,
    search_params,
    text_query,
)
from tcg_search.query.suggest import build_autocomplete


def _bool(body):
    return body["query"]["bool"]


def test_whole_body_filter_only_catalog_query():
    body = build_search(SearchRequest(q="t:dragon c:r mv<=4", page_size=10),
                        index_kind="catalog")
    aggs = body.pop("aggs")
    assert body == {
        "query": {"bool": {
            "must": [],
            "filter": [
                {"match": {"type_line": {"query": "dragon", "operator": "and"}}},
                {"bool": {"filter": [{"term": {"colors": "R"}}]}},
                {"range": {"mana_value": {"lte": 4.0}}},
            ],
            "must_not": [{"term": {"digital_only": True}}],
            "should": [{"nested": {
                "path": "printings",
                "query": {"match_all": {}},
                "score_mode": "none",
                "inner_hits": {"name": "copies", "size": 3, "sort": [
                    {"printings.price_cents": {"order": "asc", "missing": "_last"}}]},
            }}],
            "minimum_should_match": 0,
        }},
        "from": 0,
        "size": 10,
        "sort": [{"edhrec_rank": {"order": "asc", "missing": "_last"}}, {"name.sort": "asc"}],
        "track_total_hits": True,
        "track_scores": True,
        "_source": {"excludes": ["printings", "names_exact", "oracle_text"]},
    }
    assert list(aggs) == facet_names("catalog")


def test_whole_body_free_text_listings():
    body = build_search(SearchRequest(q="bolt", mode="stock", page_size=5),
                        index_kind="listings", tenant_id="t-1")
    body.pop("aggs")
    assert body["query"]["bool"] == {
        "must": [text_query("bolt")],
        "filter": [{"term": {"tenant_id": "t-1"}}],
        "must_not": [],
        "should": [
            {"nested": {"path": "offers", "query": {"match_all": {}}, "score_mode": "none",
                        "inner_hits": {"name": "copies", "size": 50, "sort": [
                            {"offers.price_cents": {"order": "asc", "missing": "_last"}}]}}},
            {"rank_feature": {"field": "popularity", "saturation": {"pivot": 1000.0},
                              "boost": 6.0}},
            {"rank_feature": {"field": "stock_depth", "saturation": {"pivot": 4.0},
                              "boost": 1.0}},
        ],
        "minimum_should_match": 0,
    }
    assert body["sort"][0] == "_score"
    assert body["_source"]["excludes"][0] == "offers"
    assert search_params("listings", "t-1") == {"routing": "t-1"}
    assert search_params("catalog", None) == {}


def test_text_query_clause_order_and_names():
    names = [list(c.values())[0].get("_name") for c in text_query("x")["bool"]["should"]]
    assert names == ["exact", "nick", "short", "name", "fuzzy", "prefix", "text"]


# --- tenant isolation: every listings query path is wrapped ------------------

QUERIES = ["", "bolt", "t:dragon c:r", "-c:r goblin", 's:alpha r:rare', "cond>=lp usd<5",
           "is:foil -s:lea", '"lightning bolt"', "foo:bar", "is:digital"]
FACETS = [{}, {"colors": ["R"]}, {"set": ["lea"], "condition": ["NM"]},
          {"price": ["0-100"], "rarity": ["rare"], "types": ["creature"]}]


def _tenant_filtered(body, tenant):
    return {"term": {"tenant_id": tenant}} in body["query"]["bool"]["filter"]


@pytest.mark.parametrize(
    "q, facets, sort", list(itertools.product(QUERIES, FACETS, SORTS + ("bogus",)))
)
def test_every_listings_query_is_tenant_filtered(q, facets, sort):
    req = SearchRequest(q=q, mode="stock", facets=facets, sort=sort, page=3)
    body = build_search(req, index_kind="listings", tenant_id="tenant-a")
    assert _tenant_filtered(body, "tenant-a")
    # ...and never mentions another tenant or the catalog's nested path.
    text = json.dumps(body)
    assert "printings" not in text
    assert text.count('"tenant_id"') == 1


@pytest.mark.parametrize("tenant", [None, "", "   "])
def test_listings_without_tenant_is_refused(tenant):
    with pytest.raises(ValueError, match="tenant"):
        build_search(SearchRequest(q="bolt"), index_kind="listings", tenant_id=tenant)
    with pytest.raises(ValueError, match="tenant"):
        build_autocomplete("bol", index_kind="listings", tenant_id=tenant)


def test_autocomplete_tenant_wrap_and_catalog_digital_filter():
    lst = build_autocomplete("bol", index_kind="listings", tenant_id="t9")
    assert {"term": {"tenant_id": "t9"}} in lst["query"]["bool"]["filter"]
    cat = build_autocomplete("bol", index_kind="catalog")
    assert cat["query"]["bool"]["filter"] == []
    assert {"term": {"digital_only": True}} in cat["query"]["bool"]["must_not"]


def test_catalog_ignores_tenant_and_unknown_kind():
    body = build_search(SearchRequest(q="bolt"), index_kind="catalog", tenant_id="t")
    assert "tenant_id" not in json.dumps(body)
    with pytest.raises(ValueError):
        build_search(SearchRequest(), index_kind="nope")


# --- clauses -----------------------------------------------------------------


def _filters(q, kind="catalog"):
    tenant = "t" if kind == "listings" else None
    return _bool(build_search(SearchRequest(q=q), index_kind=kind, tenant_id=tenant))


def test_copy_clauses_share_one_nested_query():
    b = _filters("s:alpha r>=rare a:\"christopher rush\"")
    (nested,) = [f for f in b["filter"] if "nested" in f]
    assert nested["nested"]["path"] == "printings"
    assert nested["nested"]["query"]["bool"]["filter"] == [
        {"bool": {"should": [{"term": {"printings.set": "lea"}},
                             {"match_phrase": {"printings.set_name": "alpha"}}],
                  "minimum_should_match": 1}},
        {"terms": {"printings.rarity": ["rare", "mythic"]}},
        {"match_phrase": {"printings.artist": "christopher rush"}},
    ]


def test_negated_copy_clause_is_must_not_nested():
    b = _filters("-s:lea")
    assert b["must_not"][0]["nested"]["path"] == "printings"


def test_condition_and_finish_on_listings():
    b = _filters("cond>=lp is:foil usd<5", kind="listings")
    (nested,) = [f for f in b["filter"] if "nested" in f]
    assert nested["nested"]["query"]["bool"]["filter"] == [
        {"range": {"offers.condition_rank": {"gte": 4}}},
        {"term": {"offers.finish": "foil"}},
        {"range": {"offers.price_cents": {"lt": 500}}},
    ]


def test_condition_is_ignored_on_catalog():
    b = _filters("cond>=lp")
    assert not [f for f in b["filter"] if "nested" in f]


@pytest.mark.parametrize(
    "q, expected",
    [
        ("c:r", {"bool": {"filter": [{"term": {"colors": "R"}}]}}),
        ("c=r", {"bool": {"filter": [{"term": {"colors": "R"}},
                                     {"term": {"color_count": 1}}]}}),
        ("c:c", {"bool": {"filter": [{"term": {"color_count": 0}}]}}),
        ("c:m", {"range": {"color_count": {"gte": 2}}}),
        ("id<=u", {"bool": {"must_not": [{"term": {"color_identity": c}} for c in "WBRG"]}}),
        ("id:wubrg", {"match_all": {}}),
        ("id=wubrg", {"bool": {"filter": [{"term": {"color_identity": c}} for c in "WUBRG"]
                               + [{"term": {"identity_count": 5}}]}}),
        ("c>rg", {"bool": {"filter": [{"term": {"colors": "R"}}, {"term": {"colors": "G"}},
                                      {"range": {"color_count": {"gt": 2}}}]}}),
        ("mv!=3", {"bool": {"must_not": [{"term": {"mana_value": 3.0}}]}}),
        ("o:~", {"match": {"oracle_text": {"query": "cardname", "operator": "and"}}}),
        ('o:"~ deals 3"', {"match_phrase": {"oracle_text.plain": "cardname deals 3"}}),
        ("kw:Flying", {"term": {"keywords": "flying"}}),
        ("f:modern", {"term": {"legal": "modern"}}),
        ("is:dfc", {"term": {"is_dfc": True}}),
    ],
)
def test_card_clauses(q, expected):
    assert _filters(q)["filter"][0] == expected


def test_negated_card_clause_and_text():
    b = _filters("t:goblin -c:r -token")
    assert b["filter"] == [{"match": {"type_line": {"query": "goblin", "operator": "and"}}}]
    assert b["must_not"][0] == {"bool": {"filter": [{"term": {"colors": "R"}}]}}
    assert b["must_not"][1]["multi_match"]["query"] == "token"


def test_is_digital_lifts_the_default_digital_filter():
    assert {"term": {"digital_only": True}} not in _filters("is:digital")["must_not"]
    body = build_search(SearchRequest(include_digital=True), index_kind="catalog")
    assert {"term": {"digital_only": True}} not in _bool(body)["must_not"]


# --- facets --------------------------------------------------------------------


def test_multiselect_facets_post_filter_and_self_exclusion():
    req = SearchRequest(q="t:creature", facets={"colors": ["r", "g"], "set": ["LEA"],
                                                "rarity": ["rare"]})
    body = build_search(req, index_kind="catalog")
    post = body["post_filter"]["bool"]["filter"]
    assert post[0] == {"terms": {"colors": ["R", "G"]}}
    # Copy-level facets are one nested clause: the same printing must match.
    assert post[1] == {"nested": {"path": "printings", "query": {"bool": {"filter": [
        {"terms": {"printings.set": ["lea"]}},
        {"terms": {"printings.rarity": ["rare"]}},
    ]}}}}
    # The colors facet is filtered by the others but not by itself.
    colors = body["aggs"]["colors"]["filter"]["bool"]["filter"]
    assert {"terms": {"colors": ["R", "G"]}} not in colors
    assert colors[0]["nested"]["query"]["bool"]["filter"] == post[1]["nested"]["query"]["bool"][
        "filter"]
    # The set facet aggregates copies matching the other copy facet, counting cards.
    s = body["aggs"]["set"]
    assert s["filter"]["bool"]["filter"][0] == {"terms": {"colors": ["R", "G"]}}
    matching = s["aggs"]["copies"]["aggs"]["matching"]
    assert matching["filter"] == {"bool": {"filter": [{"terms": {"printings.rarity": ["rare"]}}]}}
    assert matching["aggs"]["values"]["aggs"] == {"cards": {"reverse_nested": {}}}
    # Facets nobody selected still aggregate, unfiltered.
    assert body["aggs"]["keywords"]["filter"]["bool"]["filter"][0] == {
        "terms": {"colors": ["R", "G"]}}


def test_typed_copy_clauses_scope_copy_facet_counts():
    body = build_search(SearchRequest(q="s:lea"), index_kind="catalog")
    m = body["aggs"]["rarity"]["aggs"]["copies"]["aggs"]["matching"]["filter"]
    assert m["bool"]["filter"][0]["bool"]["should"][0] == {"term": {"printings.set": "lea"}}


def test_price_facet_bands():
    body = build_search(SearchRequest(facets={"price": ["0-100", "10000-", "junk"]}),
                        index_kind="listings", tenant_id="t")
    (nested,) = body["post_filter"]["bool"]["filter"]
    ranges = nested["nested"]["query"]["bool"]["filter"][0]["bool"]["should"]
    assert ranges == [{"range": {"offers.price_cents": {"lt": 100}}},
                      {"range": {"offers.price_cents": {"gte": 10000}}}]
    agg = body["aggs"]["price"]["aggs"]["copies"]["aggs"]["matching"]["aggs"]["values"]
    assert [r["key"] for r in agg["range"]["ranges"]] == [b[0] for b in PRICE_BANDS]


def test_condition_facet_only_on_listings_and_finish_field():
    assert "condition" not in facet_names("catalog")
    lst = build_search(SearchRequest(facets={"finish": ["foil"]}), index_kind="listings",
                       tenant_id="t")
    assert lst["post_filter"]["bool"]["filter"][0]["nested"]["query"]["bool"]["filter"] == [
        {"terms": {"offers.finish": ["foil"]}}]
    cat = build_search(SearchRequest(facets={"finish": ["foil"], "condition": ["NM"]}),
                       index_kind="catalog")
    assert cat["post_filter"]["bool"]["filter"][0]["nested"]["query"]["bool"]["filter"] == [
        {"terms": {"printings.finishes": ["foil"]}}]


def test_no_post_filter_without_selections():
    assert "post_filter" not in build_search(SearchRequest(q="bolt"), index_kind="catalog")


# --- sorting and paging ------------------------------------------------------------


def test_price_sort_is_nested_and_honours_copy_filters():
    req = SearchRequest(q="bolt cond>=nm", sort="price_asc", facets={"finish": ["foil"]})
    body = build_search(req, index_kind="listings", tenant_id="t")
    spec = body["sort"][0]["offers.price_cents"]
    assert spec["order"] == "asc" and spec["mode"] == "min" and spec["missing"] == "_last"
    assert spec["nested"] == {"path": "offers", "filter": {"bool": {"filter": [
        {"range": {"offers.condition_rank": {"gte": 5}}},
        {"terms": {"offers.finish": ["foil"]}},
    ]}}}
    desc = build_search(SearchRequest(sort="price_desc"), index_kind="catalog")["sort"][0]
    assert desc["printings.price_cents"]["mode"] == "max"
    assert desc["printings.price_cents"]["nested"] == {"path": "printings"}


@pytest.mark.parametrize(
    "sort, first",
    [
        ("popular", {"edhrec_rank": {"order": "asc", "missing": "_last"}}),
        ("name", {"name.sort": "asc"}),
        ("mv", {"mana_value": {"order": "asc", "missing": "_last"}}),
        ("newest", {"latest_released_at": {"order": "desc", "missing": "_last"}}),
        ("bogus", "_score"),
    ],
)
def test_sorts(sort, first):
    assert build_search(SearchRequest(q="x", sort=sort), index_kind="catalog")["sort"][0] == first


@pytest.mark.parametrize(
    "page, size, expected",
    [
        (1, 24, (0, 24, False)),
        (3, 24, (48, 24, False)),
        (100, 24, (2376, 24, False)),
        (101, 24, (2376, 24, True)),
        (1, 500, (0, 100, False)),
        (25, 100, (2300, 100, True)),
        (0, 0, (0, 24, False)),
    ],
)
def test_paging_cap(page, size, expected):
    assert paging(SearchRequest(page=page, page_size=size)) == expected
    start, size_, _ = expected
    assert start + size_ <= 2400
