"""Integration fixtures. OpenSearch suites skip without TEST_OPENSEARCH_URL;
the extract contract suite skips without TEST_CATALOG_DATABASE_URL.

Every index an integration test creates is named `itest_<uuid>_...` and
deleted in teardown; nothing here touches `catalog*` or `listings*`."""

import os
import uuid

import pytest

TEST_OPENSEARCH_URL = os.environ.get("TEST_OPENSEARCH_URL")
TEST_CATALOG_DATABASE_URL = os.environ.get("TEST_CATALOG_DATABASE_URL")

requires_os = pytest.mark.skipif(
    not TEST_OPENSEARCH_URL, reason="TEST_OPENSEARCH_URL not set (local OpenSearch on :9200)"
)
requires_catalog_db = pytest.mark.skipif(
    not TEST_CATALOG_DATABASE_URL,
    reason="TEST_CATALOG_DATABASE_URL not set (scripts/make_contract_db.sh)",
)


@pytest.fixture(scope="module")
def os_client():
    from tcg_search.client import OpenSearch

    with OpenSearch(TEST_OPENSEARCH_URL) as c:
        yield c


@pytest.fixture(scope="module")
def prefix(os_client):
    """A unique itest_ prefix; every index starting with it is deleted after."""
    p = f"itest_{uuid.uuid4().hex[:12]}_"
    yield p
    for row in os_client.list_indices(f"{p}*"):
        assert row["index"].startswith("itest_")
        os_client.delete_index(row["index"], missing_ok=True)
