"""A small OpenSearch client over plain httpx. opensearch-py isn't worth its
extra transport for the handful of endpoints used here; this is the whole
surface: cluster health, index create/delete/get, aliases (with an atomic
swap), analyze, search, mget, count, refresh and bulk.

Errors: any non-2xx is raised as OpenSearchError(status, body); transport
failures as OpenSearchUnavailable (a subclass), so callers can map "the
cluster is down" to a 503. bulk() checks every item, retries per-item and
whole-request 429s with exponential backoff, and returns a BulkResult whose
`errors` lists the items that still failed — callers decide whether that is
fatal (the catalog builder refuses to swap on any).

Tests swap the transport for httpx.MockTransport (tests/test_client.py);
nothing here should ever hit the network in unit tests."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from tcg_search import config

TIMEOUT = httpx.Timeout(30.0, connect=3.0)
# Bulk request size: OpenSearch's sweet spot is 5–15 MB per request.
BULK_MAX_BYTES = 8 * 1024 * 1024
BULK_RETRIES = 5
BACKOFF_BASE = 0.5


class OpenSearchError(Exception):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"OpenSearch {status}: {message}")
        self.status = status
        self.body = body


class OpenSearchUnavailable(OpenSearchError):
    """Connection refused / timed out: the cluster is down or unreachable."""


@dataclass
class BulkResult:
    ok: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)
    retried: int = 0

    @property
    def failed(self) -> int:
        return len(self.errors)


# One bulk action: (action, meta, source). action is index|create|update|delete;
# source is None for delete.
BulkAction = tuple[str, dict[str, Any], dict[str, Any] | None]


def _seg(name: str) -> str:
    return quote(name, safe=",*")


class OpenSearch:
    def __init__(
        self,
        url: str | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        auth: tuple[str, str] | None = None,
        verify: bool | str | None = None,
        timeout: httpx.Timeout = TIMEOUT,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.url = (url or config.opensearch_url()).rstrip("/")
        self._sleep = sleep
        self._http = httpx.Client(
            base_url=self.url,
            timeout=timeout,
            transport=transport,
            auth=auth if auth is not None else config.opensearch_auth(),
            verify=verify if verify is not None else config.opensearch_verify(),
            headers={"Content-Type": "application/json"},
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> OpenSearch:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- plumbing -----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        content: bytes | None = None,
        params: dict[str, Any] | None = None,
        ok: tuple[int, ...] = (),
        headers: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> httpx.Response:
        try:
            resp = self._http.request(
                method,
                path,
                content=content if content is not None else (
                    json.dumps(body).encode() if body is not None else None
                ),
                params=params,
                headers=headers,
                **({"timeout": timeout} if timeout else {}),
            )
        except httpx.TimeoutException:
            raise OpenSearchUnavailable(0, f"timed out ({method} {path})") from None
        except httpx.HTTPError as err:
            raise OpenSearchUnavailable(0, f"unreachable ({method} {path}): {err}") from None
        if resp.status_code >= 400 and resp.status_code not in ok:
            raise OpenSearchError(resp.status_code, _reason(resp, method, path), _json(resp))
        return resp

    def _call(self, method: str, path: str, **kw: Any) -> Any:
        return _json(self._request(method, path, **kw))

    # --- cluster -------------------------------------------------------------

    def info(self) -> dict[str, Any]:
        return self._call("GET", "/")

    def health(self) -> dict[str, Any]:
        return self._call("GET", "/_cluster/health")

    # --- indices -------------------------------------------------------------

    def create_index(self, name: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._call("PUT", f"/{_seg(name)}", body=body)

    def delete_index(self, name: str, *, missing_ok: bool = False) -> bool:
        """True if deleted, False if it didn't exist and missing_ok."""
        if "*" in name or name in ("_all", ""):
            raise ValueError(f"refusing to delete a wildcard index pattern: {name!r}")
        resp = self._request("DELETE", f"/{_seg(name)}", ok=(404,) if missing_ok else ())
        return resp.status_code != 404

    def get_index(self, name: str) -> dict[str, Any] | None:
        """Index definitions (settings, mappings, aliases) keyed by index
        name, or None if nothing matches. `name` may be a pattern or alias."""
        resp = self._request(
            "GET", f"/{_seg(name)}", ok=(404,), params={"ignore_unavailable": "true"}
        )
        data = _json(resp) if resp.status_code != 404 else None
        return data or None

    def list_indices(self, pattern: str) -> list[dict[str, Any]]:
        """_cat/indices rows for a pattern (name, docs.count, store.size,
        creation.date.string), sorted by name. Empty if none match."""
        resp = self._request(
            "GET",
            f"/_cat/indices/{_seg(pattern)}",
            params={"format": "json", "bytes": "b", "h": "index,docs.count,store.size,health,"
                    "creation.date.string", "s": "index"},
            ok=(404,),
        )
        return [] if resp.status_code == 404 else (_json(resp) or [])

    def refresh(self, index: str) -> None:
        self._call("POST", f"/{_seg(index)}/_refresh")

    def put_settings(self, index: str, settings: dict[str, Any]) -> None:
        self._call("PUT", f"/{_seg(index)}/_settings", body=settings)

    def forcemerge(self, index: str, max_num_segments: int = 1) -> None:
        """Merge a finished, read-only index down (smaller, faster). Blocks
        until done, so use a long timeout."""
        self._call("POST", f"/{_seg(index)}/_forcemerge",
                   params={"max_num_segments": max_num_segments},
                   timeout=httpx.Timeout(600.0, connect=3.0))

    def put_mapping(self, index: str, body: dict[str, Any]) -> None:
        self._call("PUT", f"/{_seg(index)}/_mapping", body=body)

    def count(self, index: str, query: dict[str, Any] | None = None) -> int:
        body = {"query": query} if query else None
        return int(self._call("POST", f"/{_seg(index)}/_count", body=body)["count"])

    # --- aliases ------------------------------------------------------------

    def get_alias(self, alias: str) -> list[str]:
        """Indices currently behind `alias` (empty if the alias is absent)."""
        resp = self._request("GET", f"/_alias/{_seg(alias)}", ok=(404,))
        if resp.status_code == 404:
            return []
        return sorted(_json(resp) or {})

    def swap_alias(self, alias: str, new_index: str) -> list[str]:
        """Atomically point `alias` at exactly `new_index`, removing it from
        whatever it pointed at before (those indices are kept, for rollback).
        Returns the indices it was removed from."""
        old = [i for i in self.get_alias(alias) if i != new_index]
        actions: list[dict[str, Any]] = [
            {"remove": {"index": i, "alias": alias}} for i in old
        ]
        actions.append({"add": {"index": new_index, "alias": alias}})
        self._call("POST", "/_aliases", body={"actions": actions})
        return old

    # --- analysis -----------------------------------------------------------

    def analyze(
        self,
        index: str,
        text: str,
        *,
        analyzer: str | None = None,
        field: str | None = None,
    ) -> list[str]:
        body: dict[str, Any] = {"text": text}
        if analyzer:
            body["analyzer"] = analyzer
        if field:
            body["field"] = field
        data = self._call("POST", f"/{_seg(index)}/_analyze", body=body)
        return [t["token"] for t in data.get("tokens", [])]

    # --- search -------------------------------------------------------------

    def search(
        self, index: str, body: dict[str, Any], *, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self._call("POST", f"/{_seg(index)}/_search", body=body, params=params)

    def mget(self, index: str, ids: list[str]) -> list[dict[str, Any] | None]:
        """Documents' _source in `ids` order; None where not found."""
        if not ids:
            return []
        data = self._call("POST", f"/{_seg(index)}/_mget", body={"ids": ids})
        return [d.get("_source") if d.get("found") else None for d in data.get("docs", [])]

    # --- bulk ---------------------------------------------------------------

    def bulk(
        self,
        actions: Iterable[BulkAction],
        *,
        index: str | None = None,
        max_bytes: int = BULK_MAX_BYTES,
        refresh: bool = False,
    ) -> BulkResult:
        """Send actions in size-bounded chunks. Every item's status is
        checked; per-item 429s (and whole-request 429/503) are retried with
        backoff, other item failures are collected in result.errors."""
        result = BulkResult()
        chunk: list[BulkAction] = []
        size = 0
        for act in actions:
            lines = _bulk_lines(act)
            if chunk and size + len(lines) > max_bytes:
                self._bulk_chunk(chunk, index, result, refresh)
                chunk, size = [], 0
            chunk.append(act)
            size += len(lines)
        if chunk:
            self._bulk_chunk(chunk, index, result, refresh)
        return result

    def _bulk_chunk(
        self, chunk: list[BulkAction], index: str | None, result: BulkResult, refresh: bool
    ) -> None:
        pending = chunk
        path = f"/{_seg(index)}/_bulk" if index else "/_bulk"
        params = {"refresh": "true"} if refresh else None
        for attempt in range(BULK_RETRIES + 1):
            payload = b"".join(_bulk_lines(a) for a in pending)
            resp = self._request(
                "POST",
                path,
                content=payload,
                params=params,
                ok=(429, 503),
                headers={"Content-Type": "application/x-ndjson"},
            )
            if resp.status_code in (429, 503):
                if attempt == BULK_RETRIES:
                    raise OpenSearchError(resp.status_code, "bulk rejected after retries")
                result.retried += len(pending)
                self._sleep(BACKOFF_BASE * 2**attempt)
                continue
            items = (_json(resp) or {}).get("items")
            if not isinstance(items, list) or len(items) != len(pending):
                raise OpenSearchError(resp.status_code, "bulk: unexpected response shape")
            retry: list[BulkAction] = []
            for act, item in zip(pending, items, strict=True):
                (op_result,) = item.values()
                status = op_result.get("status", 0)
                if status < 300 or (act[0] == "delete" and status == 404):
                    result.ok += 1
                elif status == 429 and attempt < BULK_RETRIES:
                    retry.append(act)
                else:
                    result.errors.append(
                        {
                            "action": act[0],
                            "_id": op_result.get("_id", act[1].get("_id")),
                            "status": status,
                            "error": op_result.get("error"),
                        }
                    )
            if not retry:
                return
            result.retried += len(retry)
            pending = retry
            self._sleep(BACKOFF_BASE * 2**attempt)


def _bulk_lines(act: BulkAction) -> bytes:
    op, meta, source = act
    out = json.dumps({op: meta}, separators=(",", ":")) + "\n"
    if op != "delete":
        out += json.dumps(source, separators=(",", ":"), default=str) + "\n"
    return out.encode()


def _json(resp: httpx.Response) -> Any:
    if not resp.content:
        return None
    try:
        return resp.json()
    except ValueError:
        return {"raw": resp.text[:500]}


def _reason(resp: httpx.Response, method: str, path: str) -> str:
    data = _json(resp)
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        detail = err.get("reason") or err.get("type")
        root = err.get("root_cause") or []
        if root and isinstance(root[0], dict) and root[0].get("reason") not in (None, detail):
            detail = f"{detail} ({root[0].get('reason')})"
    else:
        detail = err or resp.reason_phrase
    return f"{method} {path}: {detail}"
