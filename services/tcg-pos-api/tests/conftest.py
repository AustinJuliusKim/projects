"""Shared DB fixtures. DB-backed suites mark themselves skipped without
TEST_DATABASE_URL (CI's service container sets it); the schema is dropped
and re-migrated once per session, like services/mtg-api's tests.

Seeding connects as the TEST_DATABASE_URL user (a superuser locally and in
CI), which bypasses RLS. Anything asserting isolation must go through the
API or through `app_conn`, which drops to the RLS-bound tcg_pos_app role
exactly as the API's tenant session does.

Auth: every API call carries a real RS256 access token, signed by a key
generated for this test session and verified through the app's normal
JWKS path (AUTH_JWKS_URL points at a file:// JWKS written here). headers()
mints one for a named user and makes that user a member of the tenant
(owner unless `role` says otherwise); actor_of() gives the actor string the
database stamps on that user's ledger and audit rows."""

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

from tcg_pos_api.auth.dev import access_claims, generate_key, key_id, public_jwk, sign

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parent.parent

# --- auth: a per-session issuer ----------------------------------------------

TEST_ISSUER = "https://issuer.tcg-pos.test/pool"
TEST_CLIENT_ID = "tcg-pos-test-client"
TEST_KEY = generate_key()
TEST_KID = key_id(TEST_KEY.public_key())
AUTH_DIR = Path(tempfile.mkdtemp(prefix="tcg-pos-test-auth-"))
JWKS_FILE = AUTH_DIR / "jwks.json"
JWKS_FILE.write_text(json.dumps({"keys": [public_jwk(TEST_KEY.public_key(), TEST_KID)]}))
os.environ.update({
    "ENV": "test",
    "AUTH_ISSUER": TEST_ISSUER,
    "AUTH_CLIENT_IDS": TEST_CLIENT_ID,
    "AUTH_JWKS_URL": JWKS_FILE.as_uri(),
    "DEV_AUTH_DIR": str(AUTH_DIR / "dev"),
})


def mint(sub, *, email=None, key=TEST_KEY, kid=TEST_KID, headers=None, **claims):
    """A signed access token for `sub` from the test issuer. Keyword claims
    override (None removes one), e.g. mint(sub, token_use="id")."""
    body = access_claims(sub=sub, issuer=TEST_ISSUER, client_id=TEST_CLIENT_ID, email=email)
    body.update(claims)
    body = {k: v for k, v in body.items() if v is not None}
    if headers is None:
        return sign(key, body, kid=kid)
    import jwt

    return jwt.encode(body, key, algorithm="RS256", headers={"kid": kid, **headers})


def sub_for(name):
    return f"test|{name}"


def email_for(name):
    return name.lower() if "@" in name else f"{name.lower()}@example.test"


def bearer(name, **claims):
    claims.setdefault("email", email_for(name))
    return {"Authorization": f"Bearer {mint(sub_for(name), **claims)}"}

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
def app_conn(tenant_id, actor=None):
    """A transaction as the API sees it: role tcg_pos_app, app.tenant_id set
    (or left unset when tenant_id is None), app.actor set when given. Always
    rolled back."""
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(TEST_DATABASE_URL, row_factory=dict_row) as conn:
        conn.execute("SET LOCAL ROLE tcg_pos_app")
        if tenant_id is not None:
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        if actor is not None:
            conn.execute("SELECT set_config('app.actor', %s, true)", (actor,))
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


_db = None


def _admin_db():
    """A module-level superuser connection for headers() (a plain function,
    so it can't take the admin_conn fixture)."""
    import psycopg
    from psycopg.rows import dict_row

    global _db
    if _db is None or _db.closed:
        _db = psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row)
    return _db


def user_id_for(name):
    """The app_user id for a named test user (created on first use)."""
    return _admin_db().execute(
        "SELECT id FROM ensure_app_user(%s, %s)", (sub_for(name), email_for(name))
    ).fetchone()["id"]


def make_member(tenant, name="clerk@test", role="owner", status="active"):
    """Make the named user a `role` member of the tenant (idempotent)."""
    user = user_id_for(name)
    _admin_db().execute(
        "INSERT INTO membership (tenant_id, user_id, role_id, status) "
        "SELECT %s, %s, id, %s FROM role WHERE tenant_id IS NULL AND key = %s "
        "ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, "
        "status = EXCLUDED.status",
        (tenant["id"], user, status, role),
    )
    return user


def actor_of(name):
    """The actor the database records for the named test user's writes."""
    return f"user:{user_id_for(name)}"


def headers(tenant, actor="clerk@test", role="owner"):
    """Staff request headers: the store selector plus a bearer token for the
    named user, made a `role` member of the tenant first. actor=None sends
    no token (an unauthenticated request)."""
    h = {"X-Tenant-Id": str(tenant["id"])}
    if actor:
        make_member(tenant, actor, role)
        h.update(bearer(actor))
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


# --- fake mtg-api ----------------------------------------------------------


def price_object(printing_id, finish, open_values, *, sku_id=1, condition="NM", lang="en"):
    """One mtg-api price object, shaped like POST /v1/prices/batch returns."""
    return {
        "game": "mtg",
        "sku_id": sku_id,
        "printing_id": str(printing_id),
        "finish": finish,
        "condition": condition,
        "lang": lang,
        "snapshot_id": "2026-10-09.1",
        "as_of": "2026-10-09",
        "own": None,
        "open": open_values,
        "change": {"1d": None, "7d": None, "30d": None},
        "change_source": "mtgjson_tcgplayer",
        "stale": False,
        "attribution": ["MTGJSON", "Scryfall"],
        "provenance": [],
    }


class FakeMtgApi:
    """In-memory stand-in for services/mtg-api, served through
    httpx.MockTransport. `printings` maps (set, number) -> printing id;
    `prices` maps (printing id, finish) -> open-lane dict."""

    def __init__(self, sets=None, printings=None, prices=None):
        self.sets = sets or []
        self.printings = printings or {}
        self.prices = prices or {}
        # oracle_id -> card (mtg cards columns) / list of mtg-api Printing dicts
        self.cards = {}
        self.card_printings = {}
        self.calls = []

    def _lookup(self, item):
        if item.get("scryfall_id"):
            pid = item["scryfall_id"]
        else:
            pid = self.printings.get((str(item.get("set", "")).lower(), item.get("number")))
        finishes = [item["finish"]] if item.get("finish") else ["nonfoil", "foil", "etched"]
        out = [
            price_object(pid, f, self.prices[(str(pid), f)], sku_id=i)
            for i, f in enumerate(finishes)
            if pid and (str(pid), f) in self.prices
        ]
        return {"query": item, "prices": out, "error": None if out else "not found"}

    def handler(self, request):
        import json

        import httpx

        self.calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/v1/sets":
            return httpx.Response(200, json=self.sets)
        if request.method == "POST" and request.url.path == "/v1/prices/batch":
            items = json.loads(request.content)["items"]
            assert len(items) <= 200
            return httpx.Response(
                200,
                json={"snapshot_id": "2026-10-09.1", "results": [self._lookup(i) for i in items]},
            )
        parts = request.url.path.split("/")
        if request.method == "GET" and parts[1:3] == ["v1", "cards"] and len(parts) in (4, 5):
            card = self.cards.get(parts[3])
            if card is None:
                return httpx.Response(404, json={"detail": "no card with that oracle_id"})
            if len(parts) == 5 and parts[4] == "printings":
                return httpx.Response(200, json=self.card_printings.get(parts[3], []))
            if len(parts) == 4:
                return httpx.Response(200, json=card)
        return httpx.Response(404, json={"detail": "not found"})


@pytest.fixture
def fake_catalog(client):
    """Route the app's mtg-api calls to a FakeMtgApi (no network)."""
    import httpx

    from tcg_pos_api.catalog import Catalog, get_catalog

    fake = FakeMtgApi()

    def _override():
        catalog = Catalog("http://mtg-api.test", transport=httpx.MockTransport(fake.handler))
        try:
            yield catalog
        finally:
            catalog.close()

    client.app.dependency_overrides[get_catalog] = _override
    yield fake
    client.app.dependency_overrides.pop(get_catalog, None)


# --- storefront --------------------------------------------------------------


@pytest.fixture
def make_storefront(admin_conn):
    """Give a tenant a storefront row (published by default) selling from
    its main location. Slugs are random so tests never collide."""

    def _make(tenant, *, published=True, **overrides):
        row = {
            "tenant_id": tenant["id"],
            "slug": f"store-{uuid.uuid4().hex[:12]}",
            "display_name": "Test Store",
            "published": published,
            "location_id": tenant["location_id"],
            "holdback_copies": 0,
            "holdback_pct": 0,
            "reservation_hours": 48,
            "pickup_text": "Front counter",
        }
        row.update(overrides)
        cols = ", ".join(row)
        vals = ", ".join(f"%({k})s" for k in row)
        admin_conn.execute(f"INSERT INTO storefront ({cols}) VALUES ({vals})", row)
        return row

    return _make


def public_headers(ip=None):
    """Public storefront requests: a fresh client IP per call unless given,
    so the per-IP rate limit only bites in the test that's about it."""
    import random

    return {"X-Forwarded-For": ip or f"10.{random.randint(0, 255)}.{random.randint(0, 255)}."
            f"{random.randint(1, 254)}"}


@pytest.fixture
def make_shop(client, make_tenant, make_storefront, admin_conn):
    """A tenant with a published storefront, plus `stock(...)` to put priced
    items on its web location (seeded as superuser)."""

    def _make(name="Shop", **storefront):
        t = make_tenant(name)
        store = make_storefront(t, **storefront)

        def stock(qty, price_cents=100, *, printing_id=None, condition="NM", finish="nonfoil",
                  location_id=None):
            return admin_conn.execute(
                "INSERT INTO inventory_item (tenant_id, location_id, printing_id, condition, "
                "finish, qty, price_cents) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (t["id"], location_id or t["location_id"], printing_id or uuid.uuid4(),
                 condition, finish, qty, price_cents),
            ).fetchone()["id"]

        return {"tenant": t, "store": store, "slug": store["slug"], "stock": stock,
                "base": f"/v1/storefront/{store['slug']}"}

    return _make


def item_qty(admin_conn, item_id):
    return admin_conn.execute(
        "SELECT qty FROM inventory_item WHERE id = %s", (item_id,)
    ).fetchone()["qty"]


def api_routes(app):
    """(method, path, dependant) for every API route, including those in
    included routers (FastAPI nests them; app.routes alone doesn't list
    them)."""
    from fastapi.routing import APIRoute, iter_route_contexts

    for rc in iter_route_contexts(app.routes):
        if isinstance(rc.original_route, APIRoute):
            for method in rc.methods:
                yield method, rc.path, rc.dependant


def dependency_calls(dependant):
    """Every dependency callable under `dependant`, recursively."""
    for dep in dependant.dependencies:
        yield dep.call
        yield from dependency_calls(dep)
