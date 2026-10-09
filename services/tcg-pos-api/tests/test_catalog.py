"""mtg-api client: every failure is a 502 naming mtg-api. MockTransport only —
never the network."""

import httpx
import pytest
from fastapi import HTTPException

from tcg_pos_api.catalog import Catalog


def _catalog(handler):
    return Catalog("http://mtg-api.test", transport=httpx.MockTransport(handler))


def _raise(exc):
    def handler(request):
        raise exc

    return handler


@pytest.mark.parametrize(
    "handler, fragment",
    [
        (lambda r: httpx.Response(500), "returned 500"),
        (lambda r: httpx.Response(404, json={"detail": "no price snapshot"}), "returned 404"),
        (lambda r: httpx.Response(200, text="<html>"), "non-JSON"),
        (lambda r: httpx.Response(200, json={"oops": 1}), "unexpected response shape"),
        (_raise(httpx.ConnectError("refused")), "unreachable"),
        (_raise(httpx.ReadTimeout("slow")), "timed out"),
    ],
)
def test_batch_errors_are_502(handler, fragment):
    with pytest.raises(HTTPException) as exc:
        _catalog(handler).price_batch([{"set": "m11", "number": "149"}])
    assert exc.value.status_code == 502
    assert "mtg-api" in exc.value.detail and fragment in exc.value.detail


def test_sets_must_be_a_list():
    with pytest.raises(HTTPException) as exc:
        _catalog(lambda r: httpx.Response(200, json={"a": 1})).sets()
    assert exc.value.status_code == 502


def test_batch_is_chunked_to_200_and_kept_in_order():
    import json

    sizes = []

    def handler(request):
        items = json.loads(request.content)["items"]
        sizes.append(len(items))
        return httpx.Response(200, json={
            "snapshot_id": "s1",
            "results": [{"query": i, "prices": [], "error": "not found"} for i in items],
        })

    items = [{"set": "m11", "number": str(n)} for n in range(450)]
    snapshot, results = _catalog(handler).price_batch(items)
    assert sizes == [200, 200, 50]
    assert snapshot == "s1"
    assert [r["query"]["number"] for r in results] == [str(n) for n in range(450)]


def test_base_url_from_env(monkeypatch):
    monkeypatch.setenv("MTG_API_BASE", "http://prices.example:9000/")
    assert Catalog().base == "http://prices.example:9000"
