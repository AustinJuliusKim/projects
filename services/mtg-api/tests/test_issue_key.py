"""scripts/issue_key.py round trip against a real Postgres. Skipped without
TEST_DATABASE_URL."""

import os
import re
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

from mtg_api.apikeys import hash_key

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set (start docker compose db)"
)

SERVICE_DIR = Path(__file__).resolve().parent.parent
KEY_RE = re.compile(r"mtg_live_[0-9a-f]{32}")


@pytest.fixture(autouse=True)
def _fresh_schema():
    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        c.commit()
    result = run("scripts/migrate.py")
    assert result.returncode == 0, result.stderr


def run(*args):
    return subprocess.run(
        [sys.executable, *args],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
        text=True,
    )


def test_issue_prints_the_plaintext_key_once_and_stores_only_its_hash():
    result = run("scripts/issue_key.py", "--tier", "free", "--label", "smoke test")
    assert result.returncode == 0, result.stderr
    match = KEY_RE.search(result.stdout)
    assert match, result.stdout
    key = match.group(0)

    with psycopg.connect(TEST_DATABASE_URL) as c:
        row = c.execute(
            "SELECT key_sha256, tier, label, revoked_at FROM api_keys"
        ).fetchone()
    assert row[0] == hash_key(key)
    assert row[0] != key  # plaintext is never what's stored
    assert row[1] == "free"
    assert row[2] == "smoke test"
    assert row[3] is None
    assert key not in result.stderr  # never logged either


def _revoked_at(key: str):
    with psycopg.connect(TEST_DATABASE_URL) as c:
        return c.execute(
            "SELECT revoked_at FROM api_keys WHERE key_sha256 = %s", (hash_key(key),)
        ).fetchone()[0]


def test_revoke_by_plaintext_key():
    issued = run("scripts/issue_key.py", "--tier", "free")
    key = KEY_RE.search(issued.stdout).group(0)

    result = run("scripts/issue_key.py", "--revoke", key)
    assert result.returncode == 0, result.stderr
    assert _revoked_at(key) is not None


def test_revoke_by_sha256_hash():
    issued = run("scripts/issue_key.py", "--tier", "supporter")
    key = KEY_RE.search(issued.stdout).group(0)

    result = run("scripts/issue_key.py", "--revoke", hash_key(key))
    assert result.returncode == 0, result.stderr
    assert _revoked_at(key) is not None


def test_revoke_unknown_key_fails_loudly():
    result = run("scripts/issue_key.py", "--revoke", "mtg_live_" + "f" * 32)
    assert result.returncode == 1
    assert "no active key" in result.stderr
