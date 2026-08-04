"""Rate limiting defaults to off for the whole suite: most existing tests
share one TestClient host ("testclient") and would otherwise all draw from
the same anonymous quota within a single wall-clock minute, which has
nothing to do with what they're testing. tests/test_ratelimit.py turns it
back on for the handful of tests that exercise it directly."""

import pytest


@pytest.fixture(autouse=True)
def _ratelimit_off_by_default(monkeypatch):
    monkeypatch.setenv("RATELIMIT_ENABLED", "0")
