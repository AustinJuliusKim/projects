"""Request -> OpenSearch query body. Pure: no I/O, deterministic, so tests
compare whole dicts.

    build_search(req, *, index_kind, tenant_id=None) -> dict

index_kind is "catalog" or "listings". A listings query is ALWAYS wrapped in
a tenant filter (ValueError without a tenant_id); tests assert that for
every builder path. The caller also routes the request by tenant
(search_params()).

Ranking (free text only): exact name > nickname > name words > fuzzy name >
name prefix > cross-field text, plus EDHREC popularity (and stock depth on
listings) as additive rank_feature boosts. Weights live in WEIGHTS and are
tuned against eval/golden_search.yaml (scripts/eval_search.py).

Facets are multi-select: selections go in post_filter, and each facet's
aggregation is wrapped in a filter of every OTHER facet's selections, so a
facet still shows its alternatives. Copy-level facets (set, rarity, finish,
condition, price) aggregate over the nested printings/offers and count cards
via reverse_nested, not copies.
"""

from dataclasses import dataclass, field
from typing import Any

from tcg_search.mappings import NESTED_PATH
from tcg_search.query.syntax import (
    CONDITION_NAMES,
    RARITIES,
    Clause,
    ParsedQuery,
    parse,
)

MAX_WINDOW = 2400  # page * page_size cap
MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 24
INNER_HITS = {"catalog": 3, "listings": 50}

WEIGHTS = {
    "exact": 100.0,
    "nick": 80.0,
    "short": 25.0,
    "name": 4.0,
    "fuzzy": 1.5,
    "prefix": 1.0,
    "text": 1.0,
    "popularity": 6.0,
    "stock": 1.0,
}
POPULARITY_PIVOT = 1000.0
STOCK_PIVOT = 4.0

SORTS = ("relevance", "popular", "name", "price_asc", "price_desc", "newest", "mv")

CARD_FACETS = {
    "colors": "colors",
    "identity": "color_identity",
    "types": "types",
    "keywords": "keywords",
    "format": "legal",
}
COPY_FACETS = {"set": "set", "rarity": "rarity", "finish": None, "condition": "condition",
               "price": "price_cents"}
FACET_SIZES = {"set": 40, "keywords": 30}
# (key, label, from_cents, to_cents)
PRICE_BANDS = [
    ("0-100", "Under $1", None, 100),
    ("100-500", "$1–5", 100, 500),
    ("500-2000", "$5–20", 500, 2000),
    ("2000-5000", "$20–50", 2000, 5000),
    ("5000-10000", "$50–100", 5000, 10000),
    ("10000-", "$100+", 10000, None),
]
COPY_KEYS = {"s", "r", "a", "cond", "usd"}
COPY_IS = {"foil", "nonfoil", "etched", "promo"}
WUBRG = "WUBRG"


@dataclass
class SearchRequest:
    q: str = ""
    mode: str = "catalog"  # "catalog" | "stock" (a store's listings)
    tenant_id: str | None = None
    facets: dict[str, list[str]] = field(default_factory=dict)
    sort: str = "relevance"
    page: int = 1
    page_size: int = DEFAULT_PAGE_SIZE
    include_digital: bool = False


def facet_names(index_kind: str) -> list[str]:
    names = ["set", "rarity", "finish", "price", "colors", "identity", "types", "keywords",
             "format"]
    if index_kind == "listings":
        names.insert(3, "condition")
    return names


def paging(req: SearchRequest) -> tuple[int, int, bool]:
    """(from, size, capped). page_size is clamped to 1..100 and the window
    page*page_size to MAX_WINDOW (the last reachable page is served)."""
    size = max(1, min(int(req.page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    page = max(1, int(req.page or 1))
    capped = page * size > MAX_WINDOW
    if capped:
        page = MAX_WINDOW // size
    return (page - 1) * size, size, capped


# --- clause translation ------------------------------------------------------


def _range(field_name: str, op: str, value: Any) -> dict[str, Any]:
    if op in (":", "="):
        return {"term": {field_name: value}}
    if op == "!=":
        return {"bool": {"must_not": [{"term": {field_name: value}}]}}
    key = {"<": "lt", "<=": "lte", ">": "gt", ">=": "gte"}[op]
    return {"range": {field_name: {key: value}}}


def _color_query(field_name: str, count_field: str, letters: str, op: str,
                 default_op: str) -> dict[str, Any]:
    if letters == "M":
        q = {"range": {count_field: {"gte": 2}}}
        return {"bool": {"must_not": [q]}} if op == "!=" else q
    if op == ":":
        op = "=" if letters == "" and default_op == ">=" else default_op
    have = [{"term": {field_name: ch}} for ch in letters]
    outside = [{"term": {field_name: ch}} for ch in WUBRG if ch not in letters]
    n = len(letters)
    if op == ">=":
        return {"bool": {"filter": have}} if have else {"match_all": {}}
    if op == "<=":
        return {"bool": {"must_not": outside}} if outside else {"match_all": {}}
    if op in ("=", "!="):
        q = {"bool": {"filter": have + [{"term": {count_field: n}}]}}
        return {"bool": {"must_not": [q]}} if op == "!=" else q
    if op == ">":
        return {"bool": {"filter": have + [{"range": {count_field: {"gt": n}}}]}}
    # "<"
    return {"bool": {"must_not": outside, "filter": [{"range": {count_field: {"lt": n}}}]}}


def _rarity_query(fname: str, value: str, op: str) -> dict[str, Any]:
    if value not in RARITIES or op in ("=", ":", "!="):
        return _range(fname, op, value)
    i = RARITIES.index(value)
    pick = {
        ">=": RARITIES[i:], ">": RARITIES[i + 1:], "<=": RARITIES[: i + 1], "<": RARITIES[:i]
    }[op]
    return {"terms": {fname: pick}} if pick else {"bool": {"must_not": [{"match_all": {}}]}}


def _card_clause(c: Clause) -> dict[str, Any] | None:
    """A card-level filter clause (not negation-wrapped), or None if this
    key is copy-level / unsupported."""
    k, v, op = c.key, c.value, c.op
    if k == "t":
        return {"match": {"type_line": {"query": v, "operator": "and"}}}
    if k == "o":
        text = v.replace("~", "cardname")
        if " " in text.strip():
            return {"match_phrase": {"oracle_text.plain": text}}
        return {"match": {"oracle_text": {"query": text, "operator": "and"}}}
    if k == "name":
        return {"match": {"name": {"query": v, "operator": "and"}}}
    if k == "c":
        return _color_query("colors", "color_count", v, op, ">=")
    if k == "id":
        return _color_query("color_identity", "identity_count", v, op, "<=")
    if k == "mv":
        return _range("mana_value", op, v)
    if k == "pow":
        return _range("power_num", op, v)
    if k == "tou":
        return _range("toughness_num", op, v)
    if k == "loy":
        return _range("loyalty_num", op, v)
    if k == "f":
        return {"term": {"legal": v}}
    if k == "banned":
        return {"term": {"banned": v}}
    if k == "restricted":
        return {"term": {"restricted": v}}
    if k == "kw":
        return {"term": {"keywords": v.lower()}}
    if k == "is":
        if v == "reserved":
            return {"term": {"reserved": True}}
        if v == "dfc":
            return {"term": {"is_dfc": True}}
        if v == "digital":
            return {"term": {"digital_only": True}}
    return None


def _copy_clause(c: Clause, kind: str) -> dict[str, Any] | None:
    """A copy-level clause with full nested field paths, or None if
    unsupported for this index kind."""
    path = NESTED_PATH[kind]
    k, v, op = c.key, c.value, c.op
    if k == "s":
        return {"bool": {"should": [
            {"term": {f"{path}.set": v["code"]}},
            {"match_phrase": {f"{path}.set_name": v["name"]}},
        ], "minimum_should_match": 1}}
    if k == "r":
        return _rarity_query(f"{path}.rarity", v, op)
    if k == "a":
        return {"match_phrase": {f"{path}.artist": v}}
    if k == "usd":
        return _range(f"{path}.price_cents", op, int(round(v * 100)))
    if k == "cond":
        return _range(f"{path}.condition_rank", op, v) if kind == "listings" else None
    if k == "is" and v in COPY_IS:
        if v == "promo":
            return {"term": {f"{path}.promo": True}} if kind == "catalog" else None
        fname = f"{path}.finishes" if kind == "catalog" else f"{path}.finish"
        return {"term": {fname: v}}
    return None


def is_copy_level(c: Clause) -> bool:
    return c.key in COPY_KEYS or (c.key == "is" and c.value in COPY_IS)


def unsupported(parsed: ParsedQuery, index_kind: str) -> list[str]:
    """Warnings for filters the builder ignores on this index kind."""
    out = []
    for c in parsed.filters:
        q = _copy_clause(c, index_kind) if is_copy_level(c) else _card_clause(c)
        if q is None:
            out.append(f"{c.raw!r} isn't supported when searching {index_kind}; ignored")
    return out


def _nested(path: str, filters: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    inner = {"bool": {"filter": filters}} if filters else {"match_all": {}}
    return {"nested": {"path": path, "query": inner, **extra}}


# --- free text ---------------------------------------------------------------


def text_query(text: str) -> dict[str, Any]:
    """The relevance block for positive free text. Clauses are named so
    the response can tell an exact/name match from a fuzzy-only one."""
    w = WEIGHTS
    return {
        "bool": {
            "should": [
                {"constant_score": {"filter": {"match": {"names_exact": text}},
                                    "boost": w["exact"], "_name": "exact"}},
                {"constant_score": {"filter": {"match": {"nicknames": text}},
                                    "boost": w["nick"], "_name": "nick"}},
                {"constant_score": {"filter": {"match": {"short_names": text}},
                                    "boost": w["short"], "_name": "short"}},
                {"multi_match": {"query": text, "fields": ["name", "face_names"],
                                 "operator": "and", "boost": w["name"], "_name": "name"}},
                {"multi_match": {"query": text, "fields": ["name", "face_names"],
                                 "operator": "and", "fuzziness": "AUTO", "prefix_length": 1,
                                 "max_expansions": 50, "boost": w["fuzzy"], "_name": "fuzzy"}},
                {"multi_match": {"query": text, "type": "bool_prefix", "operator": "and",
                                 "fields": ["name.sayt", "name.sayt._2gram", "name.sayt._3gram"],
                                 "boost": w["prefix"], "_name": "prefix"}},
                {"multi_match": {"query": text, "type": "cross_fields", "operator": "and",
                                 "fields": ["name^3", "face_names^2", "type_line^1.5",
                                            "oracle_text"],
                                 "boost": w["text"], "_name": "text"}},
            ],
            "minimum_should_match": 1,
        }
    }


def _text_clause(c: Clause) -> dict[str, Any]:
    """Phrase or negated free text: a non-scoring match anywhere."""
    if c.phrase:
        return {"multi_match": {"query": c.value, "type": "phrase",
                                "fields": ["name.plain", "type_line", "oracle_text.plain"]}}
    return {"multi_match": {"query": c.value, "operator": "and",
                            "fields": ["name", "face_names", "type_line", "oracle_text"]}}


# --- facets ------------------------------------------------------------------


def _copy_facet_field(name: str, kind: str) -> str:
    path = NESTED_PATH[kind]
    if name == "finish":
        return f"{path}.finishes" if kind == "catalog" else f"{path}.finish"
    return f"{path}.{COPY_FACETS[name]}"


def _norm_facet_values(name: str, values: list[str]) -> list[str]:
    if name in ("colors", "identity"):
        return [v.upper() for v in values]
    if name == "condition":
        return [v.upper() for v in values]
    if name == "set":
        return [v.lower() for v in values]
    return [v.lower() for v in values]


def _facet_filter(name: str, values: list[str], kind: str) -> dict[str, Any]:
    if name == "price":
        bands = {b[0]: b for b in PRICE_BANDS}
        fname = _copy_facet_field("price", kind)
        ranges = []
        for v in values:
            if v in bands:
                _, _, lo, hi = bands[v]
                r = {k: x for k, x in (("gte", lo), ("lt", hi)) if x is not None}
                ranges.append({"range": {fname: r}})
        return {"bool": {"should": ranges, "minimum_should_match": 1}}
    if name in CARD_FACETS:
        return {"terms": {CARD_FACETS[name]: values}}
    return {"terms": {_copy_facet_field(name, kind): values}}


def selected_facets(req: SearchRequest, kind: str) -> dict[str, list[str]]:
    """Known, non-empty facet selections, normalized, in facet_names order."""
    allowed = facet_names(kind)
    out = {}
    for name in allowed:
        vals = [str(v) for v in (req.facets or {}).get(name) or [] if str(v).strip()]
        if vals:
            out[name] = _norm_facet_values(name, vals)
    return out


def _facet_aggs(
    kind: str, selections: dict[str, list[str]], q_copy: list[dict[str, Any]]
) -> dict[str, Any]:
    path = NESTED_PATH[kind]
    aggs: dict[str, Any] = {}
    for name in facet_names(kind):
        other_card = [_facet_filter(n, v, kind) for n, v in selections.items()
                      if n != name and n in CARD_FACETS]
        other_copy = q_copy + [_facet_filter(n, v, kind) for n, v in selections.items()
                               if n != name and n not in CARD_FACETS]
        outer = list(other_card)
        if any(n not in CARD_FACETS for n in selections if n != name):
            outer.append(_nested(path, other_copy))
        wrapper: dict[str, Any] = {"filter": {"bool": {"filter": outer}}}
        if name in CARD_FACETS:
            wrapper["aggs"] = {"values": {"terms": {"field": CARD_FACETS[name],
                                                    "size": FACET_SIZES.get(name, 20)}}}
        else:
            fname = _copy_facet_field(name, kind)
            if name == "price":
                values = {"range": {"field": fname, "ranges": [
                    {"key": key, **({"from": lo} if lo is not None else {}),
                     **({"to": hi} if hi is not None else {})}
                    for key, _, lo, hi in PRICE_BANDS
                ]}}
            else:
                values = {"terms": {"field": fname, "size": FACET_SIZES.get(name, 20)}}
            values["aggs"] = {"cards": {"reverse_nested": {}}}
            matching = ({"bool": {"filter": other_copy}} if other_copy else {"match_all": {}})
            wrapper["aggs"] = {"copies": {"nested": {"path": path}, "aggs": {
                "matching": {"filter": matching, "aggs": {"values": values}}}}}
        aggs[name] = wrapper
    return aggs


# --- sorting -----------------------------------------------------------------


def _sort(req: SearchRequest, kind: str, has_text: bool,
          copy_filters: list[dict[str, Any]]) -> list[Any]:
    path = NESTED_PATH[kind]
    tie = {"name.sort": "asc"}
    sort = req.sort if req.sort in SORTS else "relevance"
    popular = {"edhrec_rank": {"order": "asc", "missing": "_last"}}
    if sort == "relevance":
        return ["_score", popular, tie] if has_text else [popular, tie]
    if sort == "popular":
        return [popular, tie]
    if sort == "name":
        return [tie]
    if sort == "mv":
        return [{"mana_value": {"order": "asc", "missing": "_last"}}, tie]
    if sort == "newest":
        field_name = "latest_released_at" if kind == "catalog" else f"{path}.released_at"
        spec: dict[str, Any] = {"order": "desc", "missing": "_last"}
        if kind == "listings":
            spec.update(mode="max", nested=_sort_nested(path, copy_filters))
        return [{field_name: spec}, tie]
    asc = sort == "price_asc"
    return [
        {f"{path}.price_cents": {
            "order": "asc" if asc else "desc",
            "mode": "min" if asc else "max",
            "missing": "_last",
            "nested": _sort_nested(path, copy_filters),
        }},
        tie,
    ]


def _sort_nested(path: str, copy_filters: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {"path": path}
    if copy_filters:
        out["filter"] = {"bool": {"filter": copy_filters}}
    return out


# --- the builder ----------------------------------------------------------------


def build_search(
    req: SearchRequest,
    *,
    index_kind: str,
    tenant_id: str | None = None,
    parsed: ParsedQuery | None = None,
) -> dict[str, Any]:
    if index_kind not in NESTED_PATH:
        raise ValueError(f"unknown index_kind {index_kind!r}")
    if index_kind == "listings" and not (tenant_id and str(tenant_id).strip()):
        raise ValueError("listings queries require a tenant_id")
    parsed = parsed or parse(req.q)
    path = NESTED_PATH[index_kind]

    must: list[dict[str, Any]] = []
    filters: list[dict[str, Any]] = []
    must_not: list[dict[str, Any]] = []
    should: list[dict[str, Any]] = []
    q_copy: list[dict[str, Any]] = []
    neg_copy: list[dict[str, Any]] = []
    wants_digital = req.include_digital

    text = parsed.text
    if text:
        must.append(text_query(text))
    for c in parsed.clauses:
        if c.key is None:
            if c.negated:
                must_not.append(_text_clause(c))
            elif c.phrase:
                filters.append(_text_clause(c))
            continue
        if c.key == "is" and c.value == "digital":
            wants_digital = True
        if is_copy_level(c):
            q = _copy_clause(c, index_kind)
            if q is not None:
                (neg_copy if c.negated else q_copy).append(q)
            continue
        q = _card_clause(c)
        if q is not None:
            (must_not if c.negated else filters).append(q)

    if q_copy:
        filters.append(_nested(path, q_copy))
    for q in neg_copy:
        must_not.append(_nested(path, [q]))
    if index_kind == "catalog" and not wants_digital:
        must_not.append({"term": {"digital_only": True}})
    if index_kind == "listings":
        filters.insert(0, {"term": {"tenant_id": str(tenant_id)}})

    selections = selected_facets(req, index_kind)
    copy_sel = [_facet_filter(n, v, index_kind) for n, v in selections.items()
                if n not in CARD_FACETS]
    all_copy = q_copy + copy_sel

    # Inner hits: the copies that match every copy-level filter (typed and
    # faceted), cheapest first. In `should` with score_mode none, so it
    # collects without filtering or scoring.
    should.append(_nested(path, all_copy, score_mode="none", inner_hits={
        "name": "copies",
        "size": INNER_HITS[index_kind],
        "sort": [{f"{path}.price_cents": {"order": "asc", "missing": "_last"}}],
    }))
    if text:
        should.append({"rank_feature": {"field": "popularity", "saturation": {
            "pivot": POPULARITY_PIVOT}, "boost": WEIGHTS["popularity"]}})
        if index_kind == "listings":
            should.append({"rank_feature": {"field": "stock_depth", "saturation": {
                "pivot": STOCK_PIVOT}, "boost": WEIGHTS["stock"]}})

    start, size, _ = paging(req)
    body: dict[str, Any] = {
        "query": {"bool": {
            "must": must,
            "filter": filters,
            "must_not": must_not,
            "should": should,
            "minimum_should_match": 0,
        }},
        "from": start,
        "size": size,
        "sort": _sort(req, index_kind, bool(text), all_copy),
        "track_total_hits": True,
        "track_scores": True,
        "_source": {"excludes": [path, "names_exact", "oracle_text"]},
        "aggs": _facet_aggs(index_kind, selections, q_copy),
    }
    if selections:
        post: list[dict[str, Any]] = [
            _facet_filter(n, v, index_kind) for n, v in selections.items() if n in CARD_FACETS
        ]
        if copy_sel:
            post.append(_nested(path, all_copy))
        body["post_filter"] = {"bool": {"filter": post}}
    return body


def search_params(index_kind: str, tenant_id: str | None) -> dict[str, str]:
    """URL params for the _search call: listings are routed by tenant."""
    return {"routing": str(tenant_id)} if index_kind == "listings" else {}


def facet_clauses(req: SearchRequest, kind: str) -> list[Clause]:
    """Facet selections as AST clauses, echoed back with the typed ones so
    the UI can render one row of chips."""
    out = []
    for name, values in selected_facets(req, kind).items():
        shown = values
        if name == "condition":
            shown = [CONDITION_NAMES.get(int(v), v) if v.isdigit() else v for v in values]
        out.append(Clause(name, op=":", value=shown, raw=f"{name}:{','.join(shown)}",
                          source="facet"))
    return out
