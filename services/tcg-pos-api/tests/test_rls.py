"""Tenant isolation: tenant A can't see or touch tenant B's rows, through
the API or through direct SQL as the app role. Skipped without
TEST_DATABASE_URL.

The direct-SQL tests matter because they prove RLS itself does the
isolating — the API's queries never filter by tenant_id."""

import psycopg
import pytest

from conftest import adjust_body, app_conn, headers, requires_db

pytestmark = requires_db

TENANT_TABLES = [
    "location",
    "register",
    "inventory_item",
    "inventory_ledger",
    "audit_log",
    "customer",
    "credit_ledger",
    "buylist",
    "buylist_offer",
]


@pytest.fixture
def two_tenants(client, make_tenant, admin_conn):
    a, b = make_tenant("A"), make_tenant("B")
    for t in (a, b):
        admin_conn.execute(
            "INSERT INTO register (tenant_id, location_id, name) VALUES (%s, %s, 'R1')",
            (t["id"], t["location_id"]),
        )
        bl = admin_conn.execute(
            "INSERT INTO buylist (tenant_id, location_id, customer_id, created_by) "
            "VALUES (%s, %s, %s, 'seed') RETURNING id",
            (t["id"], t["location_id"], t["customer_id"]),
        ).fetchone()["id"]
        admin_conn.execute(
            "INSERT INTO buylist_offer (tenant_id, buylist_id, printing_id, condition, finish, "
            "qty) VALUES (%s, %s, gen_random_uuid(), 'NM', 'foil', 1)",
            (t["id"], bl),
        )
        client.post("/v1/inventory/adjust", json=adjust_body(t), headers=headers(t))
        client.post(
            f"/v1/customers/{t['customer_id']}/credit/issue",
            json={"amount_cents": 700, "reason": "seed"},
            headers=headers(t),
        )
    return a, b


def test_api_inventory_is_tenant_scoped(client, two_tenants, admin_conn):
    a, b = two_tenants
    items_a = client.get("/v1/inventory", headers=headers(a)).json()["items"]
    assert items_a and {i["location_id"] for i in items_a} == {str(a["location_id"])}
    # Even filtering explicitly for B's location returns nothing for A.
    page = client.get(
        "/v1/inventory", params={"location_id": str(b["location_id"])}, headers=headers(a)
    ).json()
    assert page["total"] == 0 and page["items"] == []


def test_api_credit_is_tenant_scoped(client, two_tenants, admin_conn):
    a, b = two_tenants
    b_credit = f"/v1/customers/{b['customer_id']}/credit"
    assert client.get(b_credit, headers=headers(a)).status_code == 404
    resp = client.post(
        f"{b_credit}/redeem", json={"amount_cents": 700, "reason": "steal"}, headers=headers(a)
    )
    assert resp.status_code == 404
    assert client.get(b_credit, headers=headers(b)).json()["balance_cents"] == 700


@pytest.mark.parametrize("table", TENANT_TABLES)
def test_app_role_sees_only_own_rows(two_tenants, table):
    a, b = two_tenants
    with app_conn(a["id"]) as conn:
        tenants = {r["tenant_id"] for r in conn.execute(f"SELECT tenant_id FROM {table}")}
    assert tenants == {a["id"]}, table
    with app_conn(b["id"]) as conn:
        tenants = {r["tenant_id"] for r in conn.execute(f"SELECT tenant_id FROM {table}")}
    assert tenants == {b["id"]}, table


def test_app_role_sees_only_own_tenant_and_balances(two_tenants):
    a, _ = two_tenants
    with app_conn(a["id"]) as conn:
        assert [r["id"] for r in conn.execute("SELECT id FROM tenant")] == [a["id"]]
        rows = conn.execute("SELECT customer_id FROM customer_credit_balance").fetchall()
    assert [r["customer_id"] for r in rows] == [a["customer_id"]]


@pytest.mark.parametrize("table", TENANT_TABLES + ["tenant"])
def test_unscoped_app_role_sees_nothing(two_tenants, table):
    with app_conn(None) as conn:
        assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0


def test_app_role_cannot_write_into_another_tenant(two_tenants):
    a, b = two_tenants
    # Explicit foreign tenant_id: rejected by the policy's WITH CHECK.
    with app_conn(a["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("INSERT INTO customer (tenant_id, name) VALUES (%s, 'x')", (b["id"],))
    # Moving an own row to another tenant: also WITH CHECK.
    with app_conn(a["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("UPDATE customer SET tenant_id = %s", (b["id"],))
    # Updating B's rows silently matches nothing.
    with app_conn(a["id"]) as conn:
        cur = conn.execute("UPDATE customer SET name = 'pwned' WHERE id = %s", (b["customer_id"],))
        assert cur.rowcount == 0
    # Own-tenant row pointing at B's customer: the composite FK refuses it.
    with app_conn(a["id"]) as conn, pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute(
            "INSERT INTO credit_ledger (customer_id, delta_cents, reason, actor) "
            "VALUES (%s, 100000, 'x', 'x')",
            (b["customer_id"],),
        )
    # No tenant set: tenant_id defaults to NULL, which no policy admits.
    with app_conn(None) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("INSERT INTO customer (name) VALUES ('x')")


def test_app_role_cannot_delete_or_bypass(two_tenants):
    a, _ = two_tenants
    with app_conn(a["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("DELETE FROM customer")
    with app_conn(a["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("ALTER TABLE customer DISABLE ROW LEVEL SECURITY")
    with app_conn(a["id"]) as conn:
        assert conn.execute("SELECT current_user AS u").fetchone()["u"] == "tcg_pos_app"
        row = conn.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'tcg_pos_app'"
        ).fetchone()
    assert row == {"rolsuper": False, "rolbypassrls": False}
