"""End-to-end ingest against a real Postgres (docker compose locally, service
container in CI). Skipped without TEST_DATABASE_URL."""

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set (start docker compose db)"
)

SERVICE_DIR = Path(__file__).resolve().parent.parent
FIXTURES = SERVICE_DIR / "tests" / "fixtures"


def load_jsonl(name):
    with open(FIXTURES / name, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


@pytest.fixture(scope="module")
def conn():
    import psycopg

    # Fresh schema per module run, then real migrations via the real CLI.
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
    with psycopg.connect(TEST_DATABASE_URL) as c:
        yield c


def count(conn, sql):
    return conn.execute(sql).fetchone()[0]


def test_oracle_ingest_is_idempotent(conn):
    from mtg_api.ingest.run import ingest_oracle

    objects = load_jsonl("oracle_sample.jsonl")
    first = ingest_oracle(conn, objects)
    assert first["inserted"] == 20  # 24 fixtures minus 4 skipped layouts
    assert first["updated"] == 0 and first["removed"] == 0
    assert count(conn, "SELECT count(*) FROM cards") == 20

    second = ingest_oracle(conn, objects)
    assert second == {"inserted": 0, "updated": 0, "removed": 0}


def test_oracle_errata_updates_exactly_one_row(conn):
    from mtg_api.ingest.run import ingest_oracle

    objects = load_jsonl("oracle_sample.jsonl")
    errata = copy.deepcopy(objects)
    target = next(c for c in errata if c["name"] == "Sanguine Bond")
    target["oracle_text"] += " (errata)"
    result = ingest_oracle(conn, errata)
    assert result == {"inserted": 0, "updated": 1, "removed": 0}

    # Restore the original text for the tests that follow.
    result = ingest_oracle(conn, objects)
    assert result == {"inserted": 0, "updated": 1, "removed": 0}


def test_default_ingest_builds_printings_and_sets(conn):
    from mtg_api.ingest.run import ingest_default

    objects = load_jsonl("default_sample.jsonl")
    first = ingest_default(conn, objects)
    assert first["inserted"] == count(conn, "SELECT count(*) FROM printings")
    assert first["inserted"] > 20
    assert count(conn, "SELECT count(*) FROM sets") > 10
    # Lightning Bolt has extra printings in the fixture: one card, many rows.
    bolt = count(
        conn,
        "SELECT count(*) FROM printings p JOIN cards c ON c.oracle_id = p.oracle_id "
        "WHERE c.name = 'Lightning Bolt'",
    )
    assert bolt >= 3

    second = ingest_default(conn, objects)
    assert second == {"inserted": 0, "updated": 0, "removed": 0}


def test_price_change_updates_without_touching_content_hash(conn):
    from mtg_api.ingest.run import ingest_default

    objects = copy.deepcopy(load_jsonl("default_sample.jsonl"))
    target = next(c for c in objects if c["name"] == "Black Lotus")
    before = conn.execute(
        "SELECT content_hash FROM printings WHERE id = %s", (target["id"],)
    ).fetchone()[0]
    target["prices"] = {**(target.get("prices") or {}), "usd": "123456.78"}
    result = ingest_default(conn, objects)
    assert result["updated"] == 1 and result["inserted"] == 0
    row = conn.execute(
        "SELECT content_hash, price_usd FROM printings WHERE id = %s", (target["id"],)
    ).fetchone()
    assert row[0] == before
    assert float(row[1]) == 123456.78


def test_truncated_file_aborts_removals(conn):
    from mtg_api.ingest.load import TruncatedFileError
    from mtg_api.ingest.run import ingest_oracle

    objects = load_jsonl("oracle_sample.jsonl")
    with pytest.raises(TruncatedFileError):
        ingest_oracle(conn, objects[:5])
    conn.rollback()
    assert count(conn, "SELECT count(*) FROM cards WHERE NOT is_removed") == 20


def test_removal_and_revival_roundtrip(conn):
    from mtg_api.ingest.run import ingest_oracle

    objects = load_jsonl("oracle_sample.jsonl")
    without_bolt = [c for c in objects if c["name"] != "Lightning Bolt"]
    result = ingest_oracle(conn, without_bolt)
    assert result["removed"] == 1
    assert count(conn, "SELECT count(*) FROM cards WHERE is_removed") == 1

    revived = ingest_oracle(conn, objects)
    assert revived["updated"] == 1  # unchanged hash, but is_removed flips back
    assert count(conn, "SELECT count(*) FROM cards WHERE is_removed") == 0


def test_rulings_reload_is_stable(conn):
    from mtg_api.ingest.run import ingest_rulings

    rulings = load_jsonl("rulings_sample.jsonl")
    first = ingest_rulings(conn, rulings)
    assert first["inserted"] == len(rulings)
    n = count(conn, "SELECT count(*) FROM rulings")
    ingest_rulings(conn, rulings)
    assert count(conn, "SELECT count(*) FROM rulings") == n
