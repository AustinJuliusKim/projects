"""Staff web-order handling (/v1/web-orders), the expiry job, and the
0008 table rules. Skipped without TEST_DATABASE_URL."""

import os
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import (
    SERVICE_DIR,
    TEST_DATABASE_URL,
    actor_of,
    app_conn,
    headers,
    item_qty,
    public_headers,
    requires_db,
)

pytestmark = requires_db


def reserve(client, shop, lines):
    body = {
        "idempotency_key": uuid.uuid4().hex,
        "customer": {"name": "Pat", "email": "pat@example.com"},
        "lines": [{"inventory_item_id": str(i), "qty": q} for i, q in lines],
    }
    resp = client.post(f"{shop['base']}/orders", json=body, headers=public_headers())
    assert resp.status_code == 201, resp.text
    return resp.json()


def ledger(admin_conn, item_id):
    return [
        (r["delta"], r["reason"], r["channel"], r["actor"])
        for r in admin_conn.execute(
            "SELECT delta, reason, channel, actor FROM inventory_ledger "
            "WHERE inventory_item_id = %s ORDER BY created_at",
            (item_id,),
        )
    ]


def outbox_count(admin_conn, tenant):
    return admin_conn.execute(
        "SELECT count(*) AS n FROM search_outbox WHERE tenant_id = %s", (tenant["id"],)
    ).fetchone()["n"]


def test_staff_list_is_tenant_scoped_and_filterable(client, make_shop):
    a, b = make_shop("A"), make_shop("B")
    first = reserve(client, a, [(a["stock"](3), 1)])
    second = reserve(client, a, [(a["stock"](3), 2)])
    reserve(client, b, [(b["stock"](3), 1)])
    ta = a["tenant"]
    client.post(f"/v1/web-orders/{first['id']}/cancel", headers=headers(ta))

    page = client.get("/v1/web-orders", headers=headers(ta)).json()
    assert page["total"] == 2
    assert [o["id"] for o in page["orders"]] == [second["id"], first["id"]]  # newest first
    assert page["orders"][0]["customer_email"] == "pat@example.com"
    assert page["orders"][0]["lines"][0]["qty"] == 2
    reserved = client.get("/v1/web-orders", params={"status": "reserved"},
                          headers=headers(ta)).json()
    assert [o["id"] for o in reserved["orders"]] == [second["id"]]
    assert client.get("/v1/web-orders", params={"status": "bogus"},
                      headers=headers(ta)).status_code == 422
    # B can't see, pick up or cancel A's orders.
    tb = b["tenant"]
    assert second["id"] not in {o["id"] for o in client.get(
        "/v1/web-orders", headers=headers(tb)).json()["orders"]}
    for action in ("picked-up", "cancel"):
        resp = client.post(f"/v1/web-orders/{second['id']}/{action}", headers=headers(tb))
        assert resp.status_code == 404


def test_picked_up_keeps_the_sale(client, make_shop, admin_conn):
    shop = make_shop()
    t = shop["tenant"]
    item = shop["stock"](3)
    order = reserve(client, shop, [(item, 2)])
    url = f"/v1/web-orders/{order['id']}"
    assert client.post(f"{url}/picked-up", headers=headers(t, actor=None)).status_code == 401
    resp = client.post(f"{url}/picked-up", headers=headers(t, actor="clerk"))
    assert resp.status_code == 200 and resp.json()["status"] == "picked_up"
    assert client.post(f"{url}/picked-up", headers=headers(t)).status_code == 409
    assert client.post(f"{url}/cancel", headers=headers(t)).status_code == 409
    assert item_qty(admin_conn, item) == 1
    assert [d for d, *_ in ledger(admin_conn, item)] == [-2]
    audit = admin_conn.execute(
        "SELECT actor, action FROM audit_log WHERE entity = 'web_order' AND entity_id = %s "
        "ORDER BY at", (order["id"],)
    ).fetchall()
    assert [(a["actor"], a["action"]) for a in audit] == [
        (f"storefront:{shop['slug']}", "web_order.create"),
        (actor_of("clerk"), "web_order.picked_up"),
    ]
    assert client.post(f"/v1/web-orders/{uuid.uuid4()}/picked-up",
                       headers=headers(t)).status_code == 404


def test_cancel_restores_stock_exactly_once(client, make_shop, admin_conn):
    shop = make_shop()
    t = shop["tenant"]
    a, b = shop["stock"](3), shop["stock"](1)
    order = reserve(client, shop, [(a, 2), (b, 1)])
    assert (item_qty(admin_conn, a), item_qty(admin_conn, b)) == (1, 0)
    events = outbox_count(admin_conn, t)

    resp = client.post(f"/v1/web-orders/{order['id']}/cancel", headers=headers(t, actor="mgr"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"
    assert (item_qty(admin_conn, a), item_qty(admin_conn, b)) == (3, 1)
    cancel = f"web_cancel:{order['id']}"
    reserve_reason = f"web_reserve:{order['id']}"
    assert ledger(admin_conn, a) == [
        (-2, reserve_reason, "web", f"storefront:{shop['slug']}"),
        (2, cancel, "web", actor_of("mgr")),
    ]
    assert outbox_count(admin_conn, t) - events == 2  # stock change re-lists both items

    resp = client.post(f"/v1/web-orders/{order['id']}/cancel", headers=headers(t))
    assert resp.status_code == 409
    assert (item_qty(admin_conn, a), item_qty(admin_conn, b)) == (3, 1)
    assert len(ledger(admin_conn, a)) == 2
    # The customer's page shows the new status.
    resp = client.get(f"{shop['base']}/orders/{order['id']}",
                      params={"code": order["pickup_code"]})
    assert resp.json()["status"] == "cancelled"


def test_concurrent_cancels_restore_once(client, make_shop, admin_conn):
    shop = make_shop()
    t = shop["tenant"]
    item = shop["stock"](5)
    order = reserve(client, shop, [(item, 4)])

    def go(_):
        return client.post(f"/v1/web-orders/{order['id']}/cancel",
                           headers=headers(t)).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(go, range(6)))
    assert sorted(codes) == [200] + [409] * 5
    assert item_qty(admin_conn, item) == 5


def _expire_now(admin_conn, order_id):
    admin_conn.execute(
        "UPDATE web_order SET expires_at = now() - interval '1 minute' WHERE id = %s",
        (order_id,),
    )


def test_expiry_job_releases_due_reservations_once(client, make_shop, admin_conn):
    from tcg_pos_api.jobs import expire_reservations

    shop = make_shop()
    t = shop["tenant"]
    item = shop["stock"](10)
    due = reserve(client, shop, [(item, 3)])
    fresh = reserve(client, shop, [(item, 1)])
    collected = reserve(client, shop, [(item, 2)])
    client.post(f"/v1/web-orders/{collected['id']}/picked-up", headers=headers(t))
    _expire_now(admin_conn, due["id"])
    _expire_now(admin_conn, collected["id"])  # picked up: never released
    assert item_qty(admin_conn, item) == 4

    with psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row) as conn:
        counts = expire_reservations.run(conn)
        assert counts["expired"] >= 1 and counts["failed"] == 0
        assert expire_reservations.run(conn)["expired"] == 0  # idempotent
    assert item_qty(admin_conn, item) == 7
    statuses = dict(
        (r["id"], r["status"]) for r in admin_conn.execute(
            "SELECT id, status FROM web_order WHERE tenant_id = %s", (t["id"],)
        )
    )
    assert statuses == {
        uuid.UUID(due["id"]): "expired",
        uuid.UUID(fresh["id"]): "reserved",
        uuid.UUID(collected["id"]): "picked_up",
    }
    assert ledger(admin_conn, item)[-1] == (
        3, f"web_expire:{due['id']}", "web", "job:expire_reservations",
    )
    # Cancelling an expired order is refused: no second restore.
    resp = client.post(f"/v1/web-orders/{due['id']}/cancel", headers=headers(t))
    assert resp.status_code == 409
    assert item_qty(admin_conn, item) == 7


def test_expiry_cli_runs(client, make_shop, admin_conn):
    shop = make_shop()
    item = shop["stock"](2)
    order = reserve(client, shop, [(item, 2)])
    _expire_now(admin_conn, order["id"])
    result = subprocess.run(
        [sys.executable, "-m", "tcg_pos_api.jobs.expire_reservations", "--limit", "5000"],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "expired" in result.stderr
    assert item_qty(admin_conn, item) == 2


def test_status_only_leaves_reserved(make_shop, client, admin_conn):
    shop = make_shop()
    order = reserve(client, shop, [(shop["stock"](1), 1)])
    admin_conn.execute("UPDATE web_order SET status = 'cancelled' WHERE id = %s", (order["id"],))
    # Even the owner/superuser can't resurrect it.
    for status in ("reserved", "picked_up", "expired"):
        with pytest.raises(psycopg.errors.CheckViolation):
            admin_conn.execute("UPDATE web_order SET status = %s WHERE id = %s",
                               (status, order["id"]))


def test_app_role_limits_on_web_order_tables(make_shop, client):
    a, b = make_shop("A"), make_shop("B")
    order = reserve(client, a, [(a["stock"](1), 1)])
    reserve(client, b, [(b["stock"](1), 1)])
    ta = a["tenant"]
    for stmt in (
        "DELETE FROM web_order",
        "UPDATE web_order SET total_cents = 0",
        "UPDATE web_order SET customer_email = 'x@y.z'",
        "DELETE FROM web_order_line",
        "UPDATE web_order_line SET qty = 99",
        "SELECT * FROM web_orders_due_for_expiry(10)",
    ):
        with app_conn(ta["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(stmt)
    for table in ("web_order", "web_order_line"):
        with app_conn(ta["id"]) as conn:
            tenants = {r["tenant_id"] for r in conn.execute(f"SELECT tenant_id FROM {table}")}
        assert tenants == {ta["id"]}, table
        with app_conn(None) as conn:
            assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0
    # Status (and updated_at) are the only writable columns.
    with app_conn(ta["id"]) as conn:
        conn.execute("UPDATE web_order SET status = 'picked_up', updated_at = now() "
                     "WHERE id = %s", (order["id"],))


def test_worker_role_functions(admin_conn):
    rows = admin_conn.execute(
        "SELECT p.proname, has_function_privilege('tcg_pos_app', p.oid, 'EXECUTE') AS app, "
        "has_function_privilege('tcg_pos_worker', p.oid, 'EXECUTE') AS worker "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'public' AND p.proname IN ('web_orders_due_for_expiry', "
        "'prune_storefront_rate_counters', 'storefront_rate_hit', 'claim_search_outbox', "
        "'ack_search_outbox')"
    ).fetchall()
    assert {r["proname"]: (r["app"], r["worker"]) for r in rows} == {
        "web_orders_due_for_expiry": (False, True),
        "prune_storefront_rate_counters": (False, True),
        "storefront_rate_hit": (True, False),
        "claim_search_outbox": (False, True),
        "ack_search_outbox": (False, True),
    }
