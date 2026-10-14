"""OpenSearch client against httpx.MockTransport only — never the network."""

import json

import httpx
import pytest

from tcg_search import config
from tcg_search.client import OpenSearch, OpenSearchError, OpenSearchUnavailable


def _client(handler, **kw):
    return OpenSearch(
        "http://os.test", transport=httpx.MockTransport(handler), sleep=lambda s: None, **kw
    )


def _raise(exc):
    def handler(request):
        raise exc

    return handler


def _ndjson(request):
    return [json.loads(line) for line in request.content.decode().splitlines() if line]


@pytest.mark.parametrize(
    "handler, exc_type, fragment",
    [
        (lambda r: httpx.Response(500, json={"error": {"reason": "boom"}}), OpenSearchError,
         "boom"),
        (lambda r: httpx.Response(400, json={"error": "bad"}), OpenSearchError, "bad"),
        (_raise(httpx.ConnectError("refused")), OpenSearchUnavailable, "unreachable"),
        (_raise(httpx.ReadTimeout("slow")), OpenSearchUnavailable, "timed out"),
    ],
)
def test_errors(handler, exc_type, fragment):
    with pytest.raises(exc_type) as exc:
        _client(handler).health()
    assert fragment in str(exc.value)


def test_url_auth_and_verify_from_env(monkeypatch):
    monkeypatch.setenv("OPENSEARCH_URL", "https://search.example:443/")
    monkeypatch.setenv("OPENSEARCH_USER", "u")
    monkeypatch.setenv("OPENSEARCH_PASSWORD", "p")
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"status": "green"})

    c = OpenSearch(transport=httpx.MockTransport(handler))
    assert c.url == "https://search.example:443"
    c.health()
    assert seen["url"] == "https://search.example/_cluster/health"
    assert seen["auth"].startswith("Basic ")


@pytest.mark.parametrize(
    "raw, expected", [(None, True), ("false", False), ("0", False), ("/etc/ca.pem", "/etc/ca.pem")]
)
def test_verify_parsing(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("OPENSEARCH_VERIFY", raising=False)
    else:
        monkeypatch.setenv("OPENSEARCH_VERIFY", raw)
    assert config.opensearch_verify() == expected


def test_no_auth_without_both_vars(monkeypatch):
    monkeypatch.setenv("OPENSEARCH_USER", "u")
    monkeypatch.delenv("OPENSEARCH_PASSWORD", raising=False)
    assert config.opensearch_auth() is None


def test_bulk_checks_every_item_and_retries_429_items():
    calls = []

    def handler(request):
        lines = _ndjson(request)
        calls.append(lines)
        items = []
        for meta in lines[::2]:
            (op, m), = meta.items()
            if m["_id"] == "busy" and len(calls) == 1:
                items.append({op: {"_id": "busy", "status": 429}})
            elif m["_id"] == "bad":
                items.append({op: {"_id": "bad", "status": 400,
                                   "error": {"type": "mapper_parsing_exception"}}})
            else:
                items.append({op: {"_id": m["_id"], "status": 201}})
        return httpx.Response(200, json={"errors": True, "items": items})

    res = _client(handler).bulk(
        [("index", {"_id": i}, {"n": i}) for i in ("a", "busy", "bad", "b")], index="x"
    )
    assert res.ok == 3
    assert res.retried == 1
    assert [e["_id"] for e in res.errors] == ["bad"]
    assert res.errors[0]["status"] == 400
    # The retry re-sent only the throttled item.
    assert [m["index"]["_id"] for m in calls[1][::2]] == ["busy"]


def test_bulk_retries_whole_request_429_then_gives_up():
    n = {"calls": 0}

    def handler(request):
        n["calls"] += 1
        return httpx.Response(429, json={"error": "too many"})

    with pytest.raises(OpenSearchError) as exc:
        _client(handler).bulk([("index", {"_id": "a"}, {})], index="x")
    assert exc.value.status == 429
    assert n["calls"] == 6  # first try + BULK_RETRIES


def test_bulk_chunks_by_bytes_and_delete_has_no_source():
    bodies = []

    def handler(request):
        lines = _ndjson(request)
        bodies.append(lines)
        metas = [ln for ln in lines if any(k in ln for k in ("index", "delete"))]
        return httpx.Response(200, json={"items": [
            {next(iter(m)): {"status": 404 if "delete" in m else 200}} for m in metas
        ]})

    acts = [("index", {"_id": str(i)}, {"pad": "x" * 100}) for i in range(10)]
    acts.append(("delete", {"_id": "gone"}, None))
    res = _client(handler).bulk(acts, index="x", max_bytes=400)
    assert len(bodies) > 1
    assert res.ok == 11 and not res.errors  # a 404 on delete is fine
    assert bodies[-1][-1] == {"delete": {"_id": "gone"}}


def test_bulk_unexpected_shape():
    with pytest.raises(OpenSearchError, match="unexpected response shape"):
        _client(lambda r: httpx.Response(200, json={"items": []})).bulk(
            [("index", {"_id": "a"}, {})]
        )


def test_swap_alias_is_one_atomic_request():
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path, request.content))
        if request.method == "GET":
            return httpx.Response(200, json={"catalog-1": {"aliases": {"catalog": {}}}})
        return httpx.Response(200, json={"acknowledged": True})

    old = _client(handler).swap_alias("catalog", "catalog-2")
    assert old == ["catalog-1"]
    method, path, body = seen[-1]
    assert (method, path) == ("POST", "/_aliases")
    assert json.loads(body) == {
        "actions": [
            {"remove": {"index": "catalog-1", "alias": "catalog"}},
            {"add": {"index": "catalog-2", "alias": "catalog"}},
        ]
    }


def test_get_alias_missing_is_empty():
    assert _client(lambda r: httpx.Response(404, json={})).get_alias("catalog") == []


def test_delete_index_refuses_wildcards():
    c = _client(lambda r: httpx.Response(200, json={}))
    for bad in ("catalog*", "_all", ""):
        with pytest.raises(ValueError):
            c.delete_index(bad)


def test_delete_missing_ok():
    c = _client(lambda r: httpx.Response(404, json={"error": "no such index"}))
    assert c.delete_index("nope", missing_ok=True) is False
    with pytest.raises(OpenSearchError):
        c.delete_index("nope")


def test_mget_preserves_order_and_missing():
    def handler(request):
        return httpx.Response(200, json={"docs": [
            {"_id": "a", "found": True, "_source": {"n": 1}},
            {"_id": "b", "found": False},
        ]})

    assert _client(handler).mget("catalog", ["a", "b"]) == [{"n": 1}, None]
    assert _client(handler).mget("catalog", []) == []


def test_analyze_and_search_paths():
    seen = []

    def handler(request):
        seen.append((request.url.path, json.loads(request.content)))
        if request.url.path.endswith("_analyze"):
            return httpx.Response(200, json={"tokens": [{"token": "lim"}, {"token": "dul"}]})
        return httpx.Response(200, json={"hits": {"hits": []}})

    c = _client(handler)
    assert c.analyze("catalog", "Lim-Dûl", analyzer="name") == ["lim", "dul"]
    c.search("catalog", {"size": 1})
    assert seen == [
        ("/catalog/_analyze", {"text": "Lim-Dûl", "analyzer": "name"}),
        ("/catalog/_search", {"size": 1}),
    ]
