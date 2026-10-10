"""Index bodies: the two indices share analysis and card fields, listings
require routing, and every analyzer/normalizer referenced is defined."""

from tcg_search import data, mappings
from tcg_search.analysis import analysis_settings


def _walk(props):
    for name, spec in props.items():
        yield name, spec
        yield from _walk(spec.get("properties", {}))
        yield from _walk(spec.get("fields", {}))


def test_catalog_and_listings_share_card_fields_and_analysis():
    cat = mappings.catalog_index_body()
    lst = mappings.listings_index_body()
    assert cat["settings"]["analysis"] == lst["settings"]["analysis"]
    for field, spec in mappings.CARD_FIELDS.items():
        assert cat["mappings"]["properties"][field] == spec
        assert lst["mappings"]["properties"][field] == spec


def test_nested_copy_fields_share_names():
    cat = mappings.catalog_index_body()["mappings"]["properties"]["printings"]["properties"]
    lst = mappings.listings_index_body()["mappings"]["properties"]["offers"]["properties"]
    for f in ("set", "set_name", "rarity", "price_cents", "collector_number", "printing_id"):
        assert cat[f] == lst[f]
    assert mappings.NESTED_PATH == {"catalog": "printings", "listings": "offers"}


def test_listings_require_routing_and_are_strict():
    body = mappings.listings_index_body()
    assert body["mappings"]["_routing"] == {"required": True}
    assert body["mappings"]["dynamic"] == "strict"
    assert mappings.catalog_index_body()["mappings"]["dynamic"] == "strict"
    props = body["mappings"]["properties"]
    assert props["tenant_id"] == {"type": "keyword"}
    assert props["offers"]["type"] == "nested"
    assert props["stock_depth"] == {"type": "rank_feature"}


def test_every_referenced_analyzer_exists():
    analysis = analysis_settings()
    analyzers, normalizers = set(analysis["analyzer"]), set(analysis["normalizer"])
    for body in (mappings.catalog_index_body(), mappings.listings_index_body()):
        for _, spec in _walk(body["mappings"]["properties"]):
            for key in ("analyzer", "search_analyzer"):
                if key in spec:
                    assert spec[key] in analyzers
            if "normalizer" in spec:
                assert spec["normalizer"] in normalizers
    for spec in analysis["analyzer"].values():
        for cf in spec.get("char_filter", []):
            assert cf in analysis["char_filter"]
        for f in spec.get("filter", []):
            assert f in analysis["filter"] or f in ("lowercase", "asciifolding", "flatten_graph")


def test_build_refresh_interval_and_meta():
    body = mappings.catalog_index_body({"x": 1}, refresh_interval="-1")
    assert body["settings"]["index"]["refresh_interval"] == "-1"
    assert body["settings"]["index"]["number_of_replicas"] == 0
    assert body["mappings"]["_meta"] == {"x": 1}


def test_nicknames_yaml_parsed_whole_names():
    nicks = data.nicknames()
    assert nicks["jtms"] == ["Jace, the Mind Sculptor"]
    assert nicks["power9"][0] == "Black Lotus"
    assert len(nicks["shocks"]) == 10 and len(nicks["fetches"]) == 10
    # A YAML flow list split on a comma would leave lower-case fragments.
    for names in nicks.values():
        for n in names:
            assert n[0].isupper() or n[0].isdigit(), n
    assert "bolt" in data.nicknames_by_card()["lightningbolt"]
    assert len(nicks) >= 60


def test_set_aliases():
    aliases = data.set_aliases()
    assert aliases["alpha"] == "lea"
    assert aliases["lordoftherings"] == "ltr"
