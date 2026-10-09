"""Shared DB fixtures. DB-backed suites mark themselves skipped without
TEST_DATABASE_URL (CI's service container sets it); the schema is dropped
and re-migrated once per session, like services/mtg-api's tests.

Seeding connects as the TEST_DATABASE_URL user (a superuser locally and in
CI), which bypasses RLS. Anything asserting isolation must go through the
API or through `app_conn`, which drops to the RLS-bound tcg_pos_app role
exactly as deps.get_conn does."""

import contextlib
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parent.parent

requires_db = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set (start docker compose db)"
)


@pytest.fixture(scope="session")
def migrated_db():
    import psycopg

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
    return TEST_DATABASE_URL


@pytest.fixture(scope="session")
def client(migrated_db):
    from fastapi.testclient import TestClient

    os.environ["DATABASE_URL"] = migrated_db
    from tcg_pos_api.app import create_app

    with TestClient(create_app()) as tc:
        yield tc


@pytest.fixture
def admin_conn(migrated_db):
    """Superuser connection (bypasses RLS), autocommit — for seeding."""
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(migrated_db, autocommit=True, row_factory=dict_row) as conn:
        yield conn


@contextlib.contextmanager
def app_conn(tenant_id):
    """A transaction as the API sees it: role tcg_pos_app, app.tenant_id set
    (or left unset when tenant_id is None). Always rolled back."""
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(TEST_DATABASE_URL, row_factory=dict_row) as conn:
        conn.execute("SET LOCAL ROLE tcg_pos_app")
        if tenant_id is not None:
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        try:
            yield conn
        finally:
            conn.rollback()


@pytest.fixture
def make_tenant(admin_conn):
    """Create a fresh tenant with one location and one customer. Fresh per
    test so tests never depend on each other's rows."""

    def _make(name="Test Store"):
        t = admin_conn.execute(
            "INSERT INTO tenant (name) VALUES (%s) RETURNING id", (name,)
        ).fetchone()["id"]
        loc = admin_conn.execute(
            "INSERT INTO location (tenant_id, name) VALUES (%s, 'Main') RETURNING id", (t,)
        ).fetchone()["id"]
        cust = admin_conn.execute(
            "INSERT INTO customer (tenant_id, name) VALUES (%s, 'Pat') RETURNING id", (t,)
        ).fetchone()["id"]
        return {"id": t, "location_id": loc, "customer_id": cust}

    return _make


def headers(tenant, actor="clerk@test"):
    h = {"X-Tenant-Id": str(tenant["id"])}
    if actor:
        h["X-Actor"] = actor
    return h


def adjust_body(tenant, **overrides):
    body = {
        "location_id": str(tenant["location_id"]),
        "printing_id": str(uuid.uuid4()),
        "condition": "NM",
        "finish": "nonfoil",
        "delta": 4,
        "reason": "intake",
    }
    body.update({k: str(v) if isinstance(v, uuid.UUID) else v for k, v in overrides.items()})
    return body
