"""Query layer: syntax -> builder -> OpenSearch -> shaped response.

  build_search(req, *, index_kind, tenant_id=None) -> dict    pure builder
  search(os_, req, ...) -> dict                               run + shape (+ did-you-mean)
  autocomplete(os_, prefix, *, tenant_id=None) -> list         in-stock first, then catalog
"""

import dataclasses
from difflib import SequenceMatcher
from typing import Any

from tcg_search import config
from tcg_search.cardtext import compact
from tcg_search.client import OpenSearch
from tcg_search.query.build import (
    MAX_WINDOW,
    SORTS,
    SearchRequest,
    build_search,
    facet_clauses,
    paging,
    search_params,
    selected_facets,
    unsupported,
)
from tcg_search.query.shape import shape_search
from tcg_search.query.suggest import autocomplete, did_you_mean
from tcg_search.query.syntax import parse

__all__ = [
    "SearchRequest",
    "autocomplete",
    "build_search",
    "parse",
    "search",
    "search_params",
]

# Relevance clauses that mean "the query named this card". A top hit with
# none of them (only fuzzy / prefix / text matches) is weak for a name-like
# query, and triggers did-you-mean.
NAME_MATCHES = {"exact", "nick", "short", "name"}
# How close a suggestion must be to the typed text (compacted) to replace
# the results ("Showing results for X") rather than nothing.
CORRECT_RATIO = 0.8


def index_kind_for(mode: str) -> str:
    return "listings" if mode == "stock" else "catalog"


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, compact(a), compact(b)).ratio()


def search(
    os_: OpenSearch,
    req: SearchRequest,
    *,
    catalog_index: str | None = None,
    listings_index: str | None = None,
) -> dict[str, Any]:
    """Run a search and shape the response. Raises OpenSearchError (and
    OpenSearchUnavailable when the cluster is down — callers map it to 503).

    Did-you-mean: for a short free-text query on page 1 whose top hit isn't a
    name match, a lenient fuzzy name search runs on the catalog. If the
    suggestion is what the results already lead with, or is close to the
    typed text, or nothing matched at all, the response is for the
    suggestion (`did_you_mean` set, `corrected` true: "Showing results for
    X"). Otherwise the original results stand and no suggestion is shown."""
    kind = index_kind_for(req.mode)
    prefix = config.index_prefix()
    catalog_index = catalog_index or f"{prefix}catalog"
    index = catalog_index if kind == "catalog" else (listings_index or f"{prefix}listings")
    tenant = req.tenant_id if kind == "listings" else None

    parsed = parse(req.q)
    warnings = list(parsed.warnings) + unsupported(parsed, kind)
    if req.sort not in SORTS:
        warnings.append(f"unknown sort {req.sort!r}; using relevance")
    selections = selected_facets(req, kind)
    unknown = sorted(k for k, v in (req.facets or {}).items() if v and k not in selections)
    if unknown:
        warnings.append(f"unknown facets ignored: {unknown}")
    start, size, capped = paging(req)
    if capped:
        warnings.append(f"results are capped at {MAX_WINDOW}; showing page {start // size + 1}")

    def run(r: SearchRequest, p=None) -> dict[str, Any]:
        return os_.search(index, build_search(r, index_kind=kind, tenant_id=tenant, parsed=p),
                          params=search_params(kind, tenant))

    raw = run(req, parsed)
    suggestion, corrected = None, False
    if parsed.is_name_like() and start == 0:
        hits = raw.get("hits", {}).get("hits", [])
        top = hits[0] if hits else None
        if not top or not set(top.get("matched_queries") or []) & NAME_MATCHES:
            cand = did_you_mean(os_, parsed.text, index=catalog_index)
            if cand:
                top_name = (top or {}).get("_source", {}).get("name")
                if top_name and compact(top_name) == compact(cand):
                    suggestion, corrected = cand, True
                elif not hits or similarity(parsed.text, cand) >= CORRECT_RATIO:
                    fixed = run(dataclasses.replace(req, q=cand))
                    if fixed.get("hits", {}).get("hits"):
                        raw, suggestion, corrected = fixed, cand, True

    clauses = [c.as_dict() for c in parsed.clauses] + [
        c.as_dict() for c in facet_clauses(req, kind)
    ]
    return shape_search(
        raw,
        req=req,
        index_kind=kind,
        clauses=clauses,
        selections=selections,
        warnings=warnings,
        page=start // size + 1,
        page_size=size,
        did_you_mean=suggestion,
        corrected=corrected,
    )
