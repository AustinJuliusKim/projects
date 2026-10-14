"""0006_storefront: staff settings, the anonymous slug lookup and the
holdback rule. Skipped without TEST_DATABASE_URL."""

import uuid

import psycopg
import pytest

from conftest import actor_of, app_conn, headers, requires_db

pytestmark = requires_db

PUBLIC_COLUMNS = [
    "tenant_id", "slug", "display_name", "location_id", "holdback_copies", "holdback_pct",
    "reservation_hours", "pickup_text", "policy_text",
]


def _settings(t, **overrides):
    body = {
        "slug": f"shop-{uuid.uuid4().hex[:10]}",
        "display_name": "  Dragon's Hoard  ",
        "published": True,
        "location_id": str(t["location_id"]),
        "holdback_copies": 1,
        "holdback_pct": 10,
        "pickup_text": "Ask at the counter",
    }
    body.update(overrides)
    return body


def test_put_creates_then_get_returns_and_audits(client, make_tenant, admin_conn):
    t = make_tenant()
    assert client.get("/v1/storefront-settings", headers=headers(t)).status_code == 404
    body = _settings(t, slug="  My-Shop-" + uuid.uuid4().hex[:6].upper())
    resp = client.put("/v1/storefront-settings", json=body, headers=headers(t, actor="owner"))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["slug"] == body["slug"].strip().lower()
    assert out["display_name"] == "Dragon's Hoard"
    assert out["reservation_hours"] == 48 and out["custom_domain"] is None
    assert client.get("/v1/storefront-settings", headers=headers(t)).json() == out

    resp = client.put(
        "/v1/storefront-settings", json={**body, "holdback_pct": 50}, headers=headers(t)
    )
    assert resp.json()["holdback_pct"] == 50
    audit = admin_conn.execute(
        "SELECT actor, action, before, after FROM audit_log WHERE tenant_id = %s "
        "AND entity = 'storefront' ORDER BY at",
        (t["id"],),
    ).fetchall()
    assert [a["action"] for a in audit] == ["storefront.update"] * 2
    assert audit[0]["actor"] == actor_of("owner") and audit[0]["before"] is None
    assert audit[1]["before"]["holdback_pct"] == 10 and audit[1]["after"]["holdback_pct"] == 50


def test_put_conflicts_and_foreign_location(client, make_tenant):
    a, b = make_tenant("A"), make_tenant("B")
    domain = f"{uuid.uuid4().hex[:8]}.example.com"
    body = _settings(a, custom_domain=domain.upper())
    assert client.put("/v1/storefront-settings", json=body, headers=headers(a)).status_code == 200
    resp = client.put(
        "/v1/storefront-settings", json=_settings(b, slug=body["slug"]), headers=headers(b)
    )
    assert resp.status_code == 409 and "slug" in resp.json()["detail"]
    resp = client.put(
        "/v1/storefront-settings", json=_settings(b, custom_domain=domain), headers=headers(b)
    )
    assert resp.status_code == 409 and "domain" in resp.json()["detail"]
    resp = client.put(
        "/v1/storefront-settings",
        json=_settings(b, location_id=str(a["location_id"])),
        headers=headers(b),
    )
    assert resp.status_code == 404
    assert client.get("/v1/storefront-settings", headers=headers(b)).status_code == 404


def test_put_validation(client, make_tenant):
    t = make_tenant()
    for bad in (
        {"slug": "ab"},
        {"slug": "has space"},
        {"slug": "x" * 41},
        {"display_name": " "},
        {"display_name": "a\x00b"},
        {"holdback_pct": 101},
        {"holdback_copies": -1},
        {"reservation_hours": 0},
        {"pickup_text": "x" * 1001},
        {"pickup_text": "a\x00b"},
        {"custom_domain": "bad domain"},
    ):
        resp = client.put("/v1/storefront-settings", json=_settings(t, **bad), headers=headers(t))
        assert resp.status_code == 422, bad
    resp = client.put("/v1/storefront-settings", json=_settings(t), headers=headers(t, actor=None))
    assert resp.status_code == 401


def test_anonymous_slug_lookup_sees_only_published_public_columns(make_tenant, make_storefront):
    live = make_storefront(make_tenant(), custom_domain=f"{uuid.uuid4().hex[:8]}.example")
    hidden = make_storefront(make_tenant(), published=False)
    with app_conn(None) as conn:
        cur = conn.execute("SELECT * FROM storefront_by_slug(%s)", (live["slug"],))
        assert [d.name for d in cur.description] == PUBLIC_COLUMNS
        rows = cur.fetchall()
        assert len(rows) == 1 and rows[0]["tenant_id"] == live["tenant_id"]
        assert conn.execute(
            "SELECT * FROM storefront_by_slug(%s)", (hidden["slug"],)
        ).fetchall() == []
        assert conn.execute("SELECT * FROM storefront_by_slug('no-such-store')").fetchall() == []
        # The table itself stays tenant-scoped: unscoped, the app role sees nothing.
        assert conn.execute("SELECT count(*) AS n FROM storefront").fetchone()["n"] == 0


def test_storefront_is_tenant_scoped(make_tenant, make_storefront):
    a, b = make_tenant(), make_tenant()
    make_storefront(a)
    make_storefront(b)
    with app_conn(a["id"]) as conn:
        tenants = [r["tenant_id"] for r in conn.execute("SELECT tenant_id FROM storefront")]
    assert tenants == [a["id"]]
    with app_conn(a["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("DELETE FROM storefront")


def test_function_grants(admin_conn):
    rows = admin_conn.execute(
        "SELECT p.proname, has_function_privilege('tcg_pos_app', p.oid, 'EXECUTE') AS app, "
        "has_function_privilege('tcg_pos_worker', p.oid, 'EXECUTE') AS worker, p.prosecdef, "
        "p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'public' AND p.proname IN "
        "('storefront_by_slug', 'published_storefronts', 'web_available')"
    ).fetchall()
    by = {r["proname"]: r for r in rows}
    assert (by["storefront_by_slug"]["app"], by["storefront_by_slug"]["worker"]) == (True, False)
    assert (by["published_storefronts"]["app"], by["published_storefronts"]["worker"]) == (
        False,
        True,
    )
    assert by["web_available"]["app"] and by["web_available"]["worker"]
    for name in ("storefront_by_slug", "published_storefronts"):
        assert by[name]["prosecdef"] is True
        assert by[name]["proconfig"] == ["search_path=public, pg_temp"]


def test_definer_policy_targets_the_function_owner(admin_conn):
    """Locally the owner is a superuser and bypasses RLS anyway, so check the
    policy that lets a non-BYPASSRLS owner (Supabase) run the lookups."""
    row = admin_conn.execute(
        "SELECT pol.roles, pol.cmd, pol.qual, "
        "(SELECT proowner::regrole::text FROM pg_proc WHERE proname = 'storefront_by_slug') "
        "AS fn_owner FROM pg_policies pol "
        "WHERE pol.tablename = 'storefront' AND pol.policyname = 'definer_published_read'"
    ).fetchone()
    assert row["roles"] == [row["fn_owner"]]
    assert row["cmd"] == "SELECT" and row["qual"] == "published"


def test_published_storefronts_lists_published_only(make_tenant, make_storefront, admin_conn):
    live = make_storefront(make_tenant())
    hidden = make_storefront(make_tenant(), published=False)
    slugs = {r["slug"] for r in admin_conn.execute("SELECT slug FROM published_storefronts()")}
    assert live["slug"] in slugs and hidden["slug"] not in slugs


@pytest.mark.parametrize(
    ("qty", "copies", "pct", "expected"),
    [
        (0, 0, 0, 0),
        (5, 0, 0, 5),
        (1, 1, 0, 0),  # a one-copy holdback hides a single copy
        (3, 1, 0, 2),
        (3, 5, 0, 0),  # never negative
        (1, 0, 50, 0),  # ceil(0.5) = 1 held back
        (4, 0, 25, 3),
        (10, 2, 10, 8),  # copies beats pct (2 > 1)
        (10, 1, 30, 7),  # pct beats copies (3 > 1)
        (7, 0, 100, 0),
        (2**31 - 1, 0, 50, 2**30 - 1),  # qty * pct must not overflow integer
    ],
)
def test_web_available(admin_conn, qty, copies, pct, expected):
    got = admin_conn.execute(
        "SELECT web_available(%s, %s, %s) AS n", (qty, copies, pct)
    ).fetchone()["n"]
    assert got == expected
