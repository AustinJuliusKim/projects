"""Inventory API against a real Postgres. Skipped without TEST_DATABASE_URL."""

import uuid

import psycopg
import pytest

from conftest import actor_of, adjust_body, app_conn, headers, requires_db

pytestmark = requires_db


def test_health(client):
    assert client.get("/v1/health").json() == {"ok": True}


def test_adjust_creates_item_and_applies_deltas(client, make_tenant):
    t = make_tenant()
    printing = uuid.uuid4()
    resp = client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing), headers=headers(t)
    )
    assert resp.status_code == 200, resp.text
    item = resp.json()["item"]
    assert item["qty"] == 4
    assert item["price_cents"] is None  # unpriced, not $0
    assert item["game"] == "mtg" and item["lang"] == "en"

    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, delta=-3, reason="sale", channel="pos"),
        headers=headers(t),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["item"]["id"] == item["id"]  # same grain → same row
    assert resp.json()["item"]["qty"] == 1

    # A different condition is a different grain.
    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, condition="LP", delta=2),
        headers=headers(t),
    )
    assert resp.json()["item"]["id"] != item["id"]

    page = client.get(
        "/v1/inventory", params={"printing_id": str(printing)}, headers=headers(t)
    ).json()
    assert page["total"] == 2
    assert sorted(i["qty"] for i in page["items"]) == [1, 2]


def test_adjust_rejects_negative_qty_and_writes_nothing(client, make_tenant, admin_conn):
    t = make_tenant()
    printing = uuid.uuid4()
    client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing, delta=2),
        headers=headers(t),
    )
    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, delta=-3),
        headers=headers(t),
    )
    assert resp.status_code == 409
    # Negative delta on a grain that doesn't exist yet: also 409, and no
    # zero-qty row is left behind.
    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=uuid.uuid4(), delta=-1),
        headers=headers(t),
    )
    assert resp.status_code == 409

    items = admin_conn.execute(
        "SELECT qty FROM inventory_item WHERE tenant_id = %s", (t["id"],)
    ).fetchall()
    assert [r["qty"] for r in items] == [2]
    n_ledger = admin_conn.execute(
        "SELECT count(*) AS n FROM inventory_ledger WHERE tenant_id = %s", (t["id"],)
    ).fetchone()["n"]
    n_audit = admin_conn.execute(
        "SELECT count(*) AS n FROM audit_log WHERE tenant_id = %s", (t["id"],)
    ).fetchone()["n"]
    assert (n_ledger, n_audit) == (1, 1)


def test_adjust_writes_ledger_and_audit(client, make_tenant, admin_conn):
    t = make_tenant()
    printing = uuid.uuid4()
    first = client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing, delta=5),
        headers=headers(t, actor="alice"),
    ).json()
    second = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, delta=-2, reason="sale", channel="pos"),
        headers=headers(t, actor="bob"),
    ).json()
    item_id = first["item"]["id"]

    ledger = admin_conn.execute(
        "SELECT id, delta, reason, channel, actor FROM inventory_ledger "
        "WHERE inventory_item_id = %s ORDER BY created_at",
        (item_id,),
    ).fetchall()
    assert [(r["delta"], r["reason"], r["channel"], r["actor"]) for r in ledger] == [
        (5, "intake", "adjustment", actor_of("alice")),
        (-2, "sale", "pos", actor_of("bob")),
    ]
    assert str(ledger[1]["id"]) == second["ledger_id"]

    audit = admin_conn.execute(
        "SELECT actor, action, entity, before, after FROM audit_log "
        "WHERE entity_id = %s ORDER BY at",
        (item_id,),
    ).fetchall()
    assert [(a["actor"], a["action"], a["entity"]) for a in audit] == [
        (actor_of("alice"), "inventory.adjust", "inventory_item"),
        (actor_of("bob"), "inventory.adjust", "inventory_item"),
    ]
    assert audit[0]["before"] is None and audit[0]["after"]["qty"] == 5
    assert audit[1]["before"]["qty"] == 5 and audit[1]["after"]["qty"] == 3


def test_adjust_to_another_tenants_location_is_404(client, make_tenant, admin_conn):
    a, b = make_tenant("A"), make_tenant("B")
    body = adjust_body(a, location_id=b["location_id"])
    resp = client.post("/v1/inventory/adjust", json=body, headers=headers(a))
    assert resp.status_code == 404
    n = admin_conn.execute(
        "SELECT count(*) AS n FROM inventory_item WHERE location_id = %s", (b["location_id"],)
    ).fetchone()["n"]
    assert n == 0


def test_inventory_pagination_and_location_filter(client, make_tenant, admin_conn):
    t = make_tenant()
    other_loc = admin_conn.execute(
        "INSERT INTO location (tenant_id, name) VALUES (%s, 'Annex') RETURNING id", (t["id"],)
    ).fetchone()["id"]
    for _ in range(5):
        client.post("/v1/inventory/adjust", json=adjust_body(t), headers=headers(t))
    client.post(
        "/v1/inventory/adjust", json=adjust_body(t, location_id=other_loc), headers=headers(t)
    )
    p1 = client.get("/v1/inventory", params={"page_size": 4}, headers=headers(t)).json()
    p2 = client.get("/v1/inventory", params={"page_size": 4, "page": 2}, headers=headers(t)).json()
    assert p1["total"] == p2["total"] == 6
    assert len(p1["items"]) == 4 and len(p2["items"]) == 2
    assert not {i["id"] for i in p1["items"]} & {i["id"] for i in p2["items"]}
    annex = client.get(
        "/v1/inventory", params={"location_id": str(other_loc)}, headers=headers(t)
    ).json()
    assert annex["total"] == 1


def test_adjust_body_validation(client, make_tenant):
    t = make_tenant()
    for bad in ({"delta": 0}, {"condition": "Mint"}, {"finish": "galaxy"}, {"channel": "amazon"},
                {"delta": 2**31}):
        resp = client.post("/v1/inventory/adjust", json=adjust_body(t, **bad), headers=headers(t))
        assert resp.status_code == 422, bad


@pytest.mark.parametrize("table", ["inventory_ledger", "audit_log"])
def test_ledger_tables_reject_update_and_delete(client, make_tenant, admin_conn, table):
    t = make_tenant()
    client.post("/v1/inventory/adjust", json=adjust_body(t), headers=headers(t))
    col = "reason" if table == "inventory_ledger" else "actor"

    # Even the superuser/owner is stopped by the append-only trigger.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        admin_conn.execute(f"UPDATE {table} SET {col} = 'x' WHERE tenant_id = %s", (t["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        admin_conn.execute(f"DELETE FROM {table} WHERE tenant_id = %s", (t["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        admin_conn.execute(f"TRUNCATE {table} CASCADE")

    # The app role doesn't even hold UPDATE/DELETE on these tables.
    for stmt in (f"UPDATE {table} SET {col} = 'x'", f"DELETE FROM {table}"):
        with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(stmt)

    n = admin_conn.execute(
        f"SELECT count(*) AS n FROM {table} WHERE tenant_id = %s", (t["id"],)
    ).fetchone()["n"]
    assert n == 1


def test_adjust_rejects_qty_overflow(client, make_tenant, admin_conn):
    t = make_tenant()
    printing = uuid.uuid4()
    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, delta=2**31 - 1),
        headers=headers(t),
    )
    assert resp.status_code == 200, resp.text
    resp = client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing, delta=1),
        headers=headers(t),
    )
    assert resp.status_code == 409
    assert "overflow" in resp.json()["detail"]
    qty = admin_conn.execute(
        "SELECT qty FROM inventory_item WHERE tenant_id = %s", (t["id"],)
    ).fetchone()["qty"]
    assert qty == 2**31 - 1


def test_inventory_page_is_capped(client, make_tenant):
    t = make_tenant()
    resp = client.get("/v1/inventory", params={"page": 10**12}, headers=headers(t))
    assert resp.status_code == 422
    resp = client.get("/v1/inventory", params={"page": 100_000}, headers=headers(t))
    assert resp.status_code == 200 and resp.json()["items"] == []


def test_adjust_text_fields_are_bounded_and_nul_free(client, make_tenant):
    t = make_tenant()
    for bad in (
        {"reason": "bad\x00reason"},
        {"reason": "x" * 501},
        {"reason": "   "},
        {"lang": "english"},
        {"lang": "e"},
        {"lang": "e\x00"},
        {"game": "pokemon"},
        {"game": "x" * 10_000},
    ):
        resp = client.post("/v1/inventory/adjust", json=adjust_body(t, **bad), headers=headers(t))
        assert resp.status_code == 422, bad
    # An oversized or garbage bearer token is a 401, before any DB work.
    for token in ("a" * 9000, "not.a.jwt"):
        resp = client.post(
            "/v1/inventory/adjust", json=adjust_body(t),
            headers={**headers(t, actor=None), "Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401, token


def test_lang_is_case_normalised_into_one_grain(client, make_tenant):
    t = make_tenant()
    printing = uuid.uuid4()
    first = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, lang=" JA "),
        headers=headers(t),
    ).json()["item"]
    second = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, lang="ja", reason="  more  "),
        headers=headers(t),
    ).json()["item"]
    assert first["lang"] == "ja"
    assert second["id"] == first["id"] and second["qty"] == 8


def test_db_rejects_bad_lang_and_game(make_tenant, admin_conn):
    t = make_tenant()
    for col, val in (("lang", "EN"), ("lang", "english"), ("game", "pokemon")):
        with pytest.raises(psycopg.errors.CheckViolation):
            admin_conn.execute(
                f"INSERT INTO inventory_item (tenant_id, location_id, printing_id, condition, "
                f"finish, {col}) VALUES (%s, %s, gen_random_uuid(), 'NM', 'foil', %s)",
                (t["id"], t["location_id"], val),
            )
