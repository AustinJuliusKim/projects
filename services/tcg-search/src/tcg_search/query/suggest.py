"""Autocomplete and did-you-mean.

build_autocomplete(prefix, *, index_kind, tenant_id=None, size=8) -> dict   (pure)
build_did_you_mean(text) -> dict                                          (pure)
autocomplete(os_, prefix, *, tenant_id=None, size=8) -> list[dict]
did_you_mean(os_, text) -> str | None

Autocomplete serves in-stock names first (the store's listings) and fills to
`size` from the catalog. Did-you-mean is a lenient fuzzy name search on the
catalog, used when a name-like query finds nothing or only fuzzy matches.
"""

from typing import Any

from tcg_search.cardtext import compact
from tcg_search.client import OpenSearch
from tcg_search.query.build import POPULARITY_PIVOT, search_params

AUTOCOMPLETE_SIZE = 8
SUGGEST_FIELDS = ["oracle_id", "name", "image_small", "price_cents", "in_stock", "type_line"]


def build_autocomplete(
    prefix: str, *, index_kind: str, tenant_id: str | None = None, size: int = AUTOCOMPLETE_SIZE
) -> dict[str, Any]:
    if index_kind == "listings" and not (tenant_id and str(tenant_id).strip()):
        raise ValueError("listings queries require a tenant_id")
    filters: list[dict[str, Any]] = []
    must_not: list[dict[str, Any]] = []
    if index_kind == "listings":
        filters.append({"term": {"tenant_id": str(tenant_id)}})
    else:
        must_not.append({"term": {"digital_only": True}})
    return {
        "size": size,
        "_source": SUGGEST_FIELDS,
        "query": {"bool": {
            "must": [{"bool": {"should": [
                {"multi_match": {"query": prefix, "type": "bool_prefix", "operator": "and",
                                 "fields": ["name.sayt", "name.sayt._2gram",
                                            "name.sayt._3gram"]}},
                {"constant_score": {"filter": {"match": {"names_exact": prefix}},
                                    "boost": 20}},
                {"constant_score": {"filter": {"match": {"nicknames": prefix}}, "boost": 10}},
            ], "minimum_should_match": 1}}],
            "filter": filters,
            "must_not": must_not,
            "should": [{"rank_feature": {"field": "popularity", "saturation": {
                "pivot": POPULARITY_PIVOT}, "boost": 3}}],
        }},
    }


def build_did_you_mean(text: str) -> dict[str, Any]:
    return {
        "size": 1,
        "_source": ["name"],
        "query": {"bool": {
            "must": [{"bool": {"should": [
                {"match": {"name": {"query": text, "fuzziness": "AUTO", "operator": "and",
                                    "boost": 3}}},
                {"match": {"name": {"query": text, "fuzziness": 2, "prefix_length": 0,
                                    "operator": "or", "minimum_should_match": "75%"}}},
                {"match": {"name.plain": {"query": text, "fuzziness": 2,
                                          "operator": "or", "minimum_should_match": "75%"}}},
            ], "minimum_should_match": 1}}],
            "must_not": [{"term": {"digital_only": True}}],
            "should": [{"rank_feature": {"field": "popularity", "saturation": {
                "pivot": POPULARITY_PIVOT}, "boost": 2}}],
        }},
    }


def did_you_mean(os_: OpenSearch, text: str, *, index: str) -> str | None:
    raw = os_.search(index, build_did_you_mean(text))
    hits = raw.get("hits", {}).get("hits", [])
    if not hits:
        return None
    name = hits[0]["_source"]["name"]
    return None if compact(name) == compact(text) else name


def autocomplete(
    os_: OpenSearch,
    prefix: str,
    *,
    tenant_id: str | None = None,
    size: int = AUTOCOMPLETE_SIZE,
    catalog_index: str = "catalog",
    listings_index: str = "listings",
) -> list[dict[str, Any]]:
    prefix = (prefix or "").strip()
    if not prefix:
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    if tenant_id:
        raw = os_.search(
            listings_index,
            build_autocomplete(prefix, index_kind="listings", tenant_id=tenant_id, size=size),
            params=search_params("listings", tenant_id),
        )
        for h in raw.get("hits", {}).get("hits", []):
            src = h["_source"]
            seen.add(src["oracle_id"])
            out.append({**src, "in_stock": True})
    if len(out) < size:
        raw = os_.search(catalog_index, build_autocomplete(prefix, index_kind="catalog",
                                                           size=size))
        for h in raw.get("hits", {}).get("hits", []):
            src = h["_source"]
            if src["oracle_id"] in seen:
                continue
            seen.add(src["oracle_id"])
            out.append({**src, "in_stock": False})
            if len(out) >= size:
                break
    return out[:size]
