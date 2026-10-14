"""OpenSearch glue for tcg-pos-api: index names and the FastAPI dependency.

The query building, doc shaping and HTTP client live in services/tcg-search
(package `tcg_search`); this package only wires them to the POS. Index
names follow tcg_search's TCG_SEARCH_PREFIX (empty in real use, an
`itest_<uuid>_` prefix in integration tests)."""

from collections.abc import Iterator

import httpx
from tcg_search import config as search_config
from tcg_search.client import OpenSearch

# Public requests must fail fast when the cluster is down (-> 503), well
# inside the Lambda / API Gateway timeouts.
REQUEST_TIMEOUT = httpx.Timeout(5.0, connect=1.0)


def catalog_alias() -> str:
    return f"{search_config.index_prefix()}catalog"


def listings_alias() -> str:
    return f"{search_config.index_prefix()}listings"


def get_search() -> Iterator[OpenSearch]:
    """FastAPI dependency (OPENSEARCH_URL etc.); tests override it with a
    MockTransport-backed client."""
    os_ = OpenSearch(timeout=REQUEST_TIMEOUT)
    try:
        yield os_
    finally:
        os_.close()
