"""Environment configuration. Everything has a local-dev default so the CLI
works against the WSL cluster and mtg_dev with no setup; moving to a managed
OpenSearch domain is a change of OPENSEARCH_URL (+ auth/TLS vars) only."""

import os

DEFAULT_OPENSEARCH_URL = "http://localhost:9200"
# Read-only role on the mtg catalog DB (see OPS.md "Read-only catalog role").
DEFAULT_CATALOG_DATABASE_URL = (
    "postgres://mtg_search_reader:mtg_search_reader@localhost:54329/mtg_dev"
)


def opensearch_url() -> str:
    return os.environ.get("OPENSEARCH_URL", DEFAULT_OPENSEARCH_URL).rstrip("/")


def opensearch_auth() -> tuple[str, str] | None:
    """Basic auth from OPENSEARCH_USER / OPENSEARCH_PASSWORD, if both set."""
    user, password = os.environ.get("OPENSEARCH_USER"), os.environ.get("OPENSEARCH_PASSWORD")
    return (user, password) if user and password else None


def opensearch_verify() -> bool | str:
    """OPENSEARCH_VERIFY: unset/"true" verifies TLS with the system store,
    "false" disables verification (never against a real domain), anything
    else is a path to a CA bundle."""
    raw = os.environ.get("OPENSEARCH_VERIFY", "true").strip()
    if raw.lower() in ("", "1", "true", "yes"):
        return True
    if raw.lower() in ("0", "false", "no"):
        return False
    return raw


def index_prefix() -> str:
    """Prefix for every alias and index this package creates. Empty in real
    use; tests set an `itest_<uuid>_` prefix so they never touch `catalog*`
    or `listings*`."""
    return os.environ.get("TCG_SEARCH_PREFIX", "")


def catalog_database_url() -> str:
    return os.environ.get("CATALOG_DATABASE_URL", DEFAULT_CATALOG_DATABASE_URL)
