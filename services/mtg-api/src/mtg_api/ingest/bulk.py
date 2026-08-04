"""Scryfall bulk-data access: locate the JSONL download for a source and
stream it line by line, never buffering the whole file (default-cards is
500MB+) and never touching disk."""

import json
import zlib
from collections.abc import Iterator
from datetime import datetime
from typing import Any

import httpx

from mtg_api.config import SCRYFALL_BULK_INDEX_URL, SCRYFALL_USER_AGENT

# CLI source name -> Scryfall bulk-data `type`.
SOURCES = {
    "oracle": "oracle_cards",
    "default": "default_cards",
    "rulings": "rulings",
}

HEADERS = {"User-Agent": SCRYFALL_USER_AGENT, "Accept": "application/json"}


class BulkFile:
    def __init__(self, source: str, download_uri: str, updated_at: datetime):
        self.source = source
        self.download_uri = download_uri
        self.updated_at = updated_at


def fetch_bulk_index(client: httpx.Client) -> dict[str, BulkFile]:
    """Bulk files by CLI source name. Scryfall serves JSONL only since
    2026-07-20 (jsonl_download_uri); fail loudly if the field is missing."""
    resp = client.get(SCRYFALL_BULK_INDEX_URL, headers=HEADERS)
    resp.raise_for_status()
    by_type = {entry["type"]: entry for entry in resp.json()["data"]}
    files = {}
    for source, bulk_type in SOURCES.items():
        entry = by_type.get(bulk_type)
        if entry is None:
            raise RuntimeError(f"bulk-data index has no entry of type {bulk_type!r}")
        uri = entry.get("jsonl_download_uri")
        if not uri:
            raise RuntimeError(
                f"bulk-data entry {bulk_type!r} has no jsonl_download_uri — "
                "has the bulk format changed again?"
            )
        files[source] = BulkFile(
            source=source,
            download_uri=uri,
            updated_at=datetime.fromisoformat(entry["updated_at"]),
        )
    return files


def _iter_lines(resp: httpx.Response) -> Iterator[bytes]:
    """Raw response bytes -> lines, transparently gunzipping. Scryfall serves
    the bulk JSONL gzip-compressed as file content (not Content-Encoding), so
    httpx won't decode it for us — sniff the gzip magic bytes and stream
    through a decompressor, keeping memory flat."""
    decomp: zlib._Decompress | None = None
    buf = b""
    sniffed = False
    for chunk in resp.iter_bytes():
        if not sniffed:
            buf += chunk
            if len(buf) < 2:
                continue
            sniffed = True
            if buf[:2] == b"\x1f\x8b":
                decomp = zlib.decompressobj(16 + zlib.MAX_WBITS)
                buf, raw = b"", buf
                chunk = raw
            else:
                chunk = buf
                buf = b""
        data = decomp.decompress(chunk) if decomp else chunk
        buf += data
        while True:
            nl = buf.find(b"\n")
            if nl < 0:
                break
            yield buf[:nl]
            buf = buf[nl + 1 :]
    if decomp:
        buf += decomp.flush()
    if buf.strip():
        yield buf


def stream_objects(client: httpx.Client, download_uri: str) -> Iterator[dict[str, Any]]:
    """Yield one parsed JSON object per JSONL line."""
    with client.stream("GET", download_uri, headers=HEADERS, follow_redirects=True) as resp:
        resp.raise_for_status()
        first = True
        for line in _iter_lines(resp):
            line = line.strip()
            if not line:
                continue
            if first:
                first = False
                # Guard against the pre-2026 JSON-array format reappearing:
                # a JSONL line is a complete object, an array file's first
                # line is "[" or "[{...},".
                if not line.startswith(b"{"):
                    raise RuntimeError(
                        "bulk file does not look like JSONL (first line "
                        f"begins {line[:20]!r}); refusing to parse"
                    )
            yield json.loads(line)
