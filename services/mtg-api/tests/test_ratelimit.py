"""Rate-limit middleware tests. Header/IP-extraction and fail-open/disabled
behavior are pure-function or patched-connect tests and need no DB; anything
that checks real api_keys/rate_counters rows is skipped without
TEST_DATABASE_URL. tests/conftest.py disables rate limiting by default —
every test here turns it back on explicitly."""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from mtg_api import ratelimit
from mtg_api.apikeys import hash_key
from mtg_api.app import create_app

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parent.parent

needs_db = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set (start docker compose db)"
)


def _request(headers: dict | None = None, client_host: str | None = "1.2.3.4") -> Request:
    scope = {
        "type": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": (client_host, 12345) if client_host else None,
    }
    return Request(scope)


class _BoomPsycopg:
    """Stands in for the `psycopg` name inside mtg_api.ratelimit only —
    mtg_api.deps keeps its own real `psycopg` import, so the app's actual
    DB dependency is untouched. Simulates the "patched connect" fail-open
    case without needing to break the real database."""

    def connect(self, *args, **kwargs):
        raise RuntimeError("simulated DB outage")


# ---- pure functions: no DB, no app -----------------------------------


def test_extract_key_prefers_bearer_over_x_api_key():
    req = _request({"authorization": "Bearer mtg_live_abc", "x-api-key": "mtg_live_xyz"})
    assert ratelimit._extract_key(req) == "mtg_live_abc"


def test_extract_key_falls_back_to_x_api_key_header():
    req = _request({"x-api-key": "mtg_live_xyz"})
    assert ratelimit._extract_key(req) == "mtg_live_xyz"


def test_extract_key_absent_is_none():
    assert ratelimit._extract_key(_request()) is None


def test_client_ip_uses_the_last_forwarded_for_hop():
    # The LAST entry is the one API Gateway itself appends — unspoofable.
    # Earlier entries are attacker-controlled and must be ignored.
    req = _request({"x-forwarded-for": "9.9.9.9, 10.0.0.1"}, client_host="5.5.5.5")
    assert ratelimit.client_ip(req) == "10.0.0.1"


def test_client_ip_falls_back_to_request_client():
    req = _request(client_host="5.5.5.5")
    assert ratelimit.client_ip(req) == "5.5.5.5"


def test_client_ip_rejects_a_spoofed_non_ip_last_hop():
    # A client can freely set X-Forwarded-For; if the last hop isn't a
    # real IP, fall back rather than trust it.
    req = _request({"x-forwarded-for": "9.9.9.9, not-an-ip"}, client_host="5.5.5.5")
    assert ratelimit.client_ip(req) == "5.5.5.5"


def test_client_ip_rejects_an_oversized_last_hop():
    huge = "a" * 4096
    req = _request({"x-forwarded-for": huge}, client_host="5.5.5.5")
    assert ratelimit.client_ip(req) == "5.5.5.5"


def test_client_ip_drops_an_ipv6_zone_id():
    # ipaddress accepts arbitrary text after %, so the zone must be stripped
    # or a 4KB "valid" address reaches rate_counters.
    req = _request({"x-forwarded-for": "fe80::1%" + "z" * 4096}, client_host="5.5.5.5")
    assert ratelimit.client_ip(req) == "fe80::1"


def test_client_ip_strips_a_port_from_the_last_hop():
    req = _request({"x-forwarded-for": "203.0.113.9:54321"})
    assert ratelimit.client_ip(req) == "203.0.113.9"


def test_client_ip_handles_bracketed_ipv6_with_port():
    req = _request({"x-forwarded-for": "[2001:db8::1]:443"})
    assert ratelimit.client_ip(req) == "2001:db8::1"


def test_client_ip_handles_bare_ipv6():
    req = _request({"x-forwarded-for": "2001:db8::1"})
    assert ratelimit.client_ip(req) == "2001:db8::1"


def test_client_ip_unknown_when_nothing_parses():
    req = _request({"x-forwarded-for": "garbage"}, client_host=None)
    assert ratelimit.client_ip(req) == "unknown"


def test_window_start_floors_to_the_minute():
    now = datetime(2026, 1, 1, 12, 34, 56, 789, tzinfo=UTC)
    assert ratelimit._window_start(now) == datetime(2026, 1, 1, 12, 34, 0, tzinfo=UTC)


# ---- disabled / exempt: no DB touched at all ---------------------------


def test_disabled_by_default_adds_no_headers():
    # conftest's autouse fixture already sets RATELIMIT_ENABLED=0.
    with TestClient(create_app()) as c:
        resp = c.get("/")
    assert "x-ratelimit-limit" not in resp.headers


def test_exempt_paths_skip_the_check_even_when_enabled(monkeypatch):
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    # Would blow up immediately if the limiter ever tried to connect.
    monkeypatch.setattr(ratelimit, "psycopg", _BoomPsycopg())
    with TestClient(create_app()) as c:
        for path in ("/", "/docs", "/openapi.json"):
            resp = c.get(path)
            assert resp.status_code == 200, path
            assert "x-ratelimit-limit" not in resp.headers


# ---- DB-gated: real api_keys / rate_counters rows -----------------------


@pytest.fixture
def fresh_schema(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL)
    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        c.commit()
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py"],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


@pytest.fixture
def db_client(fresh_schema, monkeypatch):
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    # TestClient's default ("testclient", ...) isn't a real IP and would
    # always resolve to the "unknown" bucket now that client_ip() validates
    # — give anonymous requests here a real, predictable identifier instead.
    with TestClient(create_app(), client=("127.0.0.1", 51234)) as c:
        yield c


def _insert_key(tier: str, revoked: bool = False) -> str:
    import uuid

    key = f"mtg_live_{uuid.uuid4().hex}"
    revoked_sql = "now()" if revoked else "NULL"
    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute(
            f"INSERT INTO api_keys (key_sha256, tier, revoked_at) VALUES (%s, %s, {revoked_sql})",
            (hash_key(key), tier),
        )
        c.commit()
    return key


@needs_db
def test_healthz_is_rate_limited(db_client):
    # Deliberately not exempt: it opens its own DB connection per call, so
    # metering it keeps that path bounded too.
    resp = db_client.get("/v1/healthz")
    assert resp.status_code == 200
    assert resp.headers["x-ratelimit-limit"] == str(ratelimit.ANONYMOUS_LIMIT)


@needs_db
def test_supporter_key_gets_the_supporter_limit(db_client):
    key = _insert_key("supporter")
    resp = db_client.get("/v1/sets", headers={"Authorization": f"Bearer {key}"})
    assert resp.status_code == 200
    assert resp.headers["x-ratelimit-limit"] == str(ratelimit.SUPPORTER_LIMIT)


@needs_db
def test_free_key_gets_the_free_limit_via_x_api_key_header(db_client):
    key = _insert_key("free")
    resp = db_client.get("/v1/sets", headers={"X-Api-Key": key})
    assert resp.status_code == 200
    assert resp.headers["x-ratelimit-limit"] == str(ratelimit.FREE_LIMIT)


@needs_db
def test_invalid_key_falls_back_to_anonymous(db_client):
    resp = db_client.get(
        "/v1/sets", headers={"Authorization": "Bearer mtg_live_" + "0" * 32}
    )
    assert resp.status_code == 200
    assert resp.headers["x-ratelimit-limit"] == str(ratelimit.ANONYMOUS_LIMIT)


@needs_db
def test_revoked_key_falls_back_to_anonymous(db_client):
    key = _insert_key("free", revoked=True)
    resp = db_client.get("/v1/sets", headers={"Authorization": f"Bearer {key}"})
    assert resp.status_code == 200
    assert resp.headers["x-ratelimit-limit"] == str(ratelimit.ANONYMOUS_LIMIT)


@needs_db
def test_429_shape_at_the_limit(db_client, monkeypatch):
    monkeypatch.setattr(ratelimit, "ANONYMOUS_LIMIT", 2)
    # Freeze the window so a minute boundary crossing mid-test can't split
    # these requests across two windows and flake the assertions.
    frozen_window = ratelimit._window_start(datetime.now(UTC))
    monkeypatch.setattr(ratelimit, "_window_start", lambda now: frozen_window)
    ok1 = db_client.get("/v1/sets")
    ok2 = db_client.get("/v1/sets")
    denied = db_client.get("/v1/sets")

    assert ok1.status_code == 200
    assert ok1.headers["x-ratelimit-remaining"] == "1"
    assert ok2.status_code == 200
    assert ok2.headers["x-ratelimit-remaining"] == "0"

    assert denied.status_code == 429
    assert denied.json()["detail"]
    assert denied.headers["x-ratelimit-limit"] == "2"
    assert denied.headers["x-ratelimit-remaining"] == "0"
    retry_after = int(denied.headers["retry-after"])
    assert 0 <= retry_after <= 60
    assert denied.headers["x-ratelimit-reset"] == str(retry_after)


@needs_db
def test_window_resets_for_the_next_minute(db_client, monkeypatch):
    monkeypatch.setattr(ratelimit, "ANONYMOUS_LIMIT", 1)
    # Freeze "the current window" so this can't race a real minute
    # boundary between inserting the old row and making the request.
    frozen_window = ratelimit._window_start(datetime.now(UTC))
    monkeypatch.setattr(ratelimit, "_window_start", lambda now: frozen_window)
    old_window = frozen_window - timedelta(minutes=5)
    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute(
            "INSERT INTO rate_counters (identifier, window_start, count) VALUES (%s, %s, %s)",
            ("ip:127.0.0.1", old_window, 999),
        )
        c.commit()

    resp = db_client.get("/v1/sets")

    assert resp.status_code == 200  # the old window's count doesn't carry over
    assert resp.headers["x-ratelimit-remaining"] == "0"  # this window's own 1st hit


@needs_db
def test_rotating_spoofed_first_hop_cant_bypass_the_limit(db_client, monkeypatch):
    monkeypatch.setattr(ratelimit, "ANONYMOUS_LIMIT", 3)
    frozen_window = ratelimit._window_start(datetime.now(UTC))
    monkeypatch.setattr(ratelimit, "_window_start", lambda now: frozen_window)

    responses = []
    for i in range(4):
        # Only the attacker-controlled first hop rotates; the last hop —
        # the one API Gateway itself would append — stays constant. A
        # limiter keyed on the first hop would never see this as one
        # caller; keyed on the last hop (the fix), it hits the limit.
        xff = f"203.0.113.{i}, 198.51.100.7"
        responses.append(db_client.get("/v1/sets", headers={"X-Forwarded-For": xff}))

    assert [r.status_code for r in responses] == [200, 200, 200, 429]
    with psycopg.connect(TEST_DATABASE_URL) as c:
        row = c.execute(
            "SELECT count FROM rate_counters WHERE identifier = %s AND window_start = %s",
            ("ip:198.51.100.7", frozen_window),
        ).fetchone()
    assert row[0] == 4


@needs_db
def test_oversized_forwarded_for_never_lands_in_rate_counters(db_client, monkeypatch):
    monkeypatch.setattr(ratelimit, "ANONYMOUS_LIMIT", 10)
    huge = "1.2.3.4, " + "b" * 4096
    resp = db_client.get("/v1/sets", headers={"X-Forwarded-For": huge})
    assert resp.status_code == 200

    with psycopg.connect(TEST_DATABASE_URL) as c:
        identifiers = {row[0] for row in c.execute("SELECT identifier FROM rate_counters")}
    assert not any(len(i) > 100 for i in identifiers)
    # Unparseable last hop falls back to the TestClient's configured IP.
    assert identifiers == {"ip:127.0.0.1"}


@needs_db
def test_concurrent_increments_yield_exactly_n(fresh_schema):
    identifier = "key:concurrency-test"
    window_start = ratelimit._window_start(datetime.now(UTC))
    n = 20

    def bump():
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as c:
            ratelimit.increment(c, identifier, window_start)

    with ThreadPoolExecutor(max_workers=n) as pool:
        list(pool.map(lambda _: bump(), range(n)))

    with psycopg.connect(TEST_DATABASE_URL) as c:
        row = c.execute(
            "SELECT count FROM rate_counters WHERE identifier = %s AND window_start = %s",
            (identifier, window_start),
        ).fetchone()
    assert row[0] == n


@needs_db
def test_fails_open_when_the_rate_check_itself_raises(fresh_schema, monkeypatch):
    monkeypatch.setenv("RATELIMIT_ENABLED", "1")
    monkeypatch.setattr(ratelimit, "psycopg", _BoomPsycopg())
    with TestClient(create_app()) as c:
        resp = c.get("/v1/sets")
    assert resp.status_code == 200
    assert "x-ratelimit-limit" not in resp.headers
