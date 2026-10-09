"""HTTP client for the card catalog and prices (services/mtg-api, a separate
service and database). The POS never reads mtg-api's tables directly: the
public HTTP API is the contract, so the two can deploy independently.

Every failure — connection error, timeout, non-2xx, unparseable body — is
raised as HTTPException(502) with a message naming mtg-api, so callers can
tell "the catalog is down" from "your request was wrong". Tests swap the
transport for httpx.MockTransport (see tests/test_pricing.py); nothing here
should ever hit the network in tests."""

import os
from collections.abc import Iterator
from typing import Any

import httpx
from fastapi import HTTPException

DEFAULT_BASE = "http://localhost:8000"
# Well inside the Lambda's 10 s timeout, leaving room for the DB work.
TIMEOUT = httpx.Timeout(6.0, connect=2.0)
# mtg-api's POST /v1/prices/batch limit (routes/prices.py BATCH_MAX).
BATCH_MAX = 200


def base_url() -> str:
    return os.environ.get("MTG_API_BASE", DEFAULT_BASE).rstrip("/")


class Catalog:
    def __init__(self, base: str | None = None, transport: httpx.BaseTransport | None = None):
        self.base = base or base_url()
        self._http = httpx.Client(base_url=self.base, timeout=TIMEOUT, transport=transport)

    def close(self) -> None:
        self._http.close()

    def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            resp = self._http.request(method, path, **kwargs)
        except httpx.TimeoutException:
            raise HTTPException(502, f"mtg-api timed out ({method} {path})") from None
        except httpx.HTTPError as err:
            raise HTTPException(502, f"mtg-api unreachable ({method} {path}): {err}") from None
        if resp.status_code >= 400:
            raise HTTPException(
                502, f"mtg-api returned {resp.status_code} for {method} {path}"
            )
        try:
            return resp.json()
        except ValueError:
            raise HTTPException(502, f"mtg-api sent a non-JSON body for {method} {path}") from None

    def sets(self) -> list[dict[str, Any]]:
        """All sets: [{"code", "name", ...}]."""
        data = self._call("GET", "/v1/sets")
        if not isinstance(data, list):
            raise HTTPException(502, "mtg-api /v1/sets: expected a list")
        return data

    def price_batch(self, items: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]]]:
        """Look up prices for batch items ({scryfall_id, finish} or
        {set, number, finish}), chunked to mtg-api's per-call limit.
        Returns (snapshot_id, results) with results in input order, each
        {"query", "prices": [...], "error"}."""
        snapshot_id, results = None, []
        for i in range(0, len(items), BATCH_MAX):
            data = self._call("POST", "/v1/prices/batch", json={"items": items[i : i + BATCH_MAX]})
            chunk = data.get("results") if isinstance(data, dict) else None
            if not isinstance(chunk, list) or len(chunk) != len(items[i : i + BATCH_MAX]):
                raise HTTPException(502, "mtg-api /v1/prices/batch: unexpected response shape")
            snapshot_id = data.get("snapshot_id") or snapshot_id
            results.extend(chunk)
        return snapshot_id, results


def get_catalog() -> Iterator[Catalog]:
    """FastAPI dependency; tests override it with a MockTransport-backed Catalog."""
    catalog = Catalog()
    try:
        yield catalog
    finally:
        catalog.close()
