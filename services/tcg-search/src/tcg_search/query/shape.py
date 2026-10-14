"""OpenSearch response -> the API's search response. Pure."""

from typing import Any

from tcg_search.query.build import CARD_FACETS, PRICE_BANDS, SearchRequest, facet_names

FACET_ORDER = facet_names("listings")

RESULT_FIELDS = (
    "oracle_id", "name", "mana_cost", "mana_value", "type_line", "oracle_text_display",
    "colors", "color_identity", "keywords", "power", "toughness", "loyalty", "defense",
    "layout", "is_dfc", "faces", "legal", "edhrec_rank", "image_small", "image_normal",
    "price_cents", "price_source", "in_stock", "tenant_id", "printing_count",
)


def shape_hit(hit: dict[str, Any], index_kind: str) -> dict[str, Any]:
    src = hit.get("_source") or {}
    out = {k: src[k] for k in RESULT_FIELDS if k in src}
    if "oracle_text_display" in out:
        out["oracle_text"] = out.pop("oracle_text_display")
    copies = [
        h.get("_source") or {}
        for h in ((hit.get("inner_hits") or {}).get("copies") or {}).get("hits", {}).get("hits", [])
    ]
    out["offers" if index_kind == "listings" else "printings"] = copies
    out["score"] = hit.get("_score")
    matched = hit.get("matched_queries")
    if matched:
        out["matched"] = sorted(matched)
    return out


def shape_facets(
    aggs: dict[str, Any] | None, selections: dict[str, list[str]]
) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    labels = {key: label for key, label, _, _ in PRICE_BANDS}
    # Stable order: the builder's facet order, whatever order the cluster returns.
    order = {n: i for i, n in enumerate(FACET_ORDER)}
    for name, agg in sorted((aggs or {}).items(), key=lambda kv: order.get(kv[0], 99)):
        if name in CARD_FACETS:
            buckets = agg.get("values", {}).get("buckets", [])
            rows = [{"value": b["key"], "count": b["doc_count"]} for b in buckets]
        else:
            buckets = agg.get("copies", {}).get("matching", {}).get("values", {}).get("buckets", [])
            rows = [
                {"value": b["key"], "count": b.get("cards", {}).get("doc_count", 0)}
                for b in buckets
            ]
            if name == "price":
                rows = [{**r, "label": labels.get(r["value"], r["value"])} for r in rows]
        chosen = set(selections.get(name, []))
        for r in rows:
            r["selected"] = str(r["value"]) in chosen
        seen = {str(r["value"]) for r in rows}
        rows += [{"value": v, "count": 0, "selected": True} for v in chosen if v not in seen]
        out[name] = [r for r in rows if r["count"] > 0 or r["selected"]]
    return out


def shape_search(
    raw: dict[str, Any],
    *,
    req: SearchRequest,
    index_kind: str,
    clauses: list[dict[str, Any]],
    selections: dict[str, list[str]],
    warnings: list[str],
    page_size: int,
    page: int,
    did_you_mean: str | None = None,
    corrected: bool = False,
) -> dict[str, Any]:
    hits = raw.get("hits", {})
    total = hits.get("total", {})
    return {
        "mode": req.mode,
        "q": req.q,
        "total": total.get("value", 0) if isinstance(total, dict) else int(total or 0),
        "took_ms": raw.get("took"),
        "page": page,
        "page_size": page_size,
        "sort": req.sort,
        "results": [shape_hit(h, index_kind) for h in hits.get("hits", [])],
        "facets": shape_facets(raw.get("aggregations"), selections),
        "query": {"clauses": clauses},
        "warnings": warnings,
        "did_you_mean": did_you_mean,
        "corrected": corrected,
    }
