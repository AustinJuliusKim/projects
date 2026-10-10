"""search() orchestration, response shaping, did-you-mean and autocomplete,
against httpx.MockTransport (no network)."""

import json

import httpx

from tcg_search.client import OpenSearch
from tcg_search.query import SearchRequest, autocomplete, search
from tcg_search.query.shape import shape_facets, shape_hit


def _hit(name, matched=(), score=1.0, **src):
    return {"_id": name, "_score": score, "matched_queries": list(matched),
            "_source": {"oracle_id": f"id-{name}", "name": name, "oracle_text_display": "Text",
                        **src},
            "inner_hits": {"copies": {"hits": {"hits": [{"_source": {"set": "m11"}}]}}}}


def _resp(*hits, total=None):
    return {"took": 3, "hits": {"total": {"value": len(hits) if total is None else total},
                                "hits": list(hits)}, "aggregations": {}}


class Fake:
    """Answers _search by looking at the request body."""

    def __init__(self, route):
        self.route = route
        self.calls = []

    def __call__(self, request):
        body = json.loads(request.content)
        self.calls.append((request.url.path, dict(request.url.params), body))
        return httpx.Response(200, json=self.route(request.url.path, body))


def _os(fake):
    return OpenSearch("http://os.test", transport=httpx.MockTransport(fake))


def _is_dym(body):
    return body.get("size") == 1 and body.get("_source") == ["name"]


def _q(body):
    """The free text of a main search body, if any."""
    must = body["query"]["bool"]["must"]
    return must[0]["bool"]["should"][0]["constant_score"]["filter"]["match"]["names_exact"] \
        if must else None


def test_strong_hit_no_did_you_mean():
    fake = Fake(lambda path, body: _resp(_hit("Lightning Bolt", ["exact", "name"])))
    res = search(_os(fake), SearchRequest(q="lightning bolt"))
    assert res["did_you_mean"] is None and res["corrected"] is False
    assert len(fake.calls) == 1
    hit = res["results"][0]
    assert hit["name"] == "Lightning Bolt"
    assert hit["oracle_text"] == "Text" and "oracle_text_display" not in hit
    assert hit["printings"] == [{"set": "m11"}]
    assert hit["matched"] == ["exact", "name"]
    assert fake.calls[0][0] == "/catalog/_search"


def test_fuzzy_only_top_hit_is_corrected_in_place():
    def route(path, body):
        if _is_dym(body):
            return _resp(_hit("Tarmogoyf"))
        return _resp(_hit("Tarmogoyf", ["fuzzy"]))

    fake = Fake(route)
    res = search(_os(fake), SearchRequest(q="tarmogyof"))
    assert res["did_you_mean"] == "Tarmogoyf" and res["corrected"] is True
    assert len(fake.calls) == 2  # search + did-you-mean, no rerun needed


def test_zero_hits_reruns_with_the_suggestion():
    def route(path, body):
        if _is_dym(body):
            return _resp(_hit("Llanowar Elves"))
        if _q(body) == "Llanowar Elves":
            return _resp(_hit("Llanowar Elves", ["exact"]))
        return _resp()

    fake = Fake(route)
    res = search(_os(fake), SearchRequest(q="llanowar elfz"))
    assert res["corrected"] is True and res["did_you_mean"] == "Llanowar Elves"
    assert [r["name"] for r in res["results"]] == ["Llanowar Elves"]
    assert len(fake.calls) == 3


def test_distant_suggestion_does_not_replace_text_results():
    def route(path, body):
        if _is_dym(body):
            return _resp(_hit("Card Draw Specialist"))
        return _resp(_hit("Opt", ["text"]))

    res = search(_os(Fake(route)), SearchRequest(q="draw a card"))
    assert res["did_you_mean"] is None and res["results"][0]["name"] == "Opt"


def test_filters_skip_did_you_mean_and_warnings_surface():
    fake = Fake(lambda path, body: _resp())
    res = search(_os(fake), SearchRequest(q="t:dragon foo:bar cond>=lp", sort="weird",
                                          facets={"nope": ["x"]}, page=500))
    assert len(fake.calls) == 1
    w = " | ".join(res["warnings"])
    assert "unknown key 'foo'" in w and "isn't supported when searching catalog" in w
    assert "unknown sort" in w and "unknown facets" in w and "capped at 2400" in w
    assert res["page"] == 100
    keys = [c["key"] for c in res["query"]["clauses"]]
    assert keys == ["t", None, "cond"]


def test_stock_mode_routes_by_tenant_and_echoes_facets():
    fake = Fake(lambda path, body: _resp(_hit("Lightning Bolt", ["exact"], in_stock=3)))
    res = search(_os(fake), SearchRequest(q="bolt", mode="stock", tenant_id="t-1",
                                          facets={"condition": ["nm"]}))
    path, params, body = fake.calls[0]
    assert path == "/listings/_search" and params == {"routing": "t-1"}
    assert {"term": {"tenant_id": "t-1"}} in body["query"]["bool"]["filter"]
    assert res["results"][0]["offers"] == [{"set": "m11"}]
    assert res["query"]["clauses"][-1] == {"key": "condition", "op": ":", "value": ["NM"],
                                           "negated": False, "raw": "condition:NM",
                                           "source": "facet"}


def test_shape_facets_counts_cards_and_keeps_selected():
    aggs = {
        "colors": {"values": {"buckets": [{"key": "R", "doc_count": 5}]}},
        "set": {"copies": {"matching": {"values": {"buckets": [
            {"key": "lea", "doc_count": 40, "cards": {"doc_count": 7}},
            {"key": "leb", "doc_count": 2, "cards": {"doc_count": 0}},
        ]}}}},
        "price": {"copies": {"matching": {"values": {"buckets": [
            {"key": "0-100", "doc_count": 9, "cards": {"doc_count": 4}}]}}}},
    }
    out = shape_facets(aggs, {"colors": ["G"], "set": ["lea"]})
    assert out["colors"] == [{"value": "R", "count": 5, "selected": False},
                             {"value": "G", "count": 0, "selected": True}]
    assert out["set"] == [{"value": "lea", "count": 7, "selected": True}]
    assert out["price"] == [{"value": "0-100", "count": 4, "selected": False,
                             "label": "Under $1"}]


def test_shape_hit_without_inner_hits():
    out = shape_hit({"_source": {"name": "X", "oracle_id": "1"}, "_score": None}, "catalog")
    assert out == {"name": "X", "oracle_id": "1", "printings": [], "score": None}


def test_autocomplete_in_stock_first_then_catalog_fill():
    def route(path, body):
        if path.startswith("/listings"):
            return _resp(_hit("Lightning Bolt"))
        return _resp(_hit("Lightning Bolt"), _hit("Lightning Helix"), _hit("Lightning Greaves"))

    fake = Fake(route)
    out = autocomplete(_os(fake), "light", tenant_id="t-1", size=3)
    assert [(s["name"], s["in_stock"]) for s in out] == [
        ("Lightning Bolt", True), ("Lightning Helix", False), ("Lightning Greaves", False)]
    assert fake.calls[0][1] == {"routing": "t-1"}
    assert autocomplete(_os(fake), "  ") == []


def test_autocomplete_catalog_only_without_tenant():
    fake = Fake(lambda path, body: _resp(_hit("Sol Ring")))
    out = autocomplete(_os(fake), "sol r")
    assert [s["name"] for s in out] == ["Sol Ring"]
    assert [c[0] for c in fake.calls] == ["/catalog/_search"]
