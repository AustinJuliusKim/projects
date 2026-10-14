"""Authorization in the database (0011_rbac): the permission vocabulary,
store selection, the actor trigger, onboarding and /v1/me. Skipped without
TEST_DATABASE_URL."""

import uuid

import psycopg
import pytest

from conftest import (
    actor_of,
    adjust_body,
    app_conn,
    bearer,
    headers,
    make_member,
    requires_db,
    user_id_for,
)
from tcg_pos_api.auth import Perm

pytestmark = requires_db


def test_permission_table_equals_perm_enum(admin_conn):
    keys = {r["key"] for r in admin_conn.execute("SELECT key FROM permission")}
    assert keys == {p.value for p in Perm}


def test_system_roles_follow_the_plan(admin_conn):
    grants = {}
    for r in admin_conn.execute(
        "SELECT r.key, rp.perm FROM role r JOIN role_permission rp ON rp.role_id = r.id "
        "WHERE r.tenant_id IS NULL"
    ):
        grants.setdefault(r["key"], set()).add(r["perm"])
    every = {p.value for p in Perm}
    assert grants["owner"] == every
    assert grants["manager"] == every - {
        "billing.manage",
        "roles.manage",
        "channels.manage",
        "apikeys.manage",
    }
    assert "approve.override" in grants["manager"]
    assert grants["buyer"] == {
        "buylist.create",
        "buylist.payout_credit",
        "buylist.payout_cash",
        "inventory.read",
        "inventory.adjust",
        "inventory.price_edit",
        "imports.run",
        "credit.read",
        "credit.issue",
        "customers.read",
        "pos.sell",
    }
    assert grants["cashier"] == {
        "pos.sell",
        "pos.discount",
        "inventory.read",
        "credit.read",
        "customers.read",
        "web_orders.read",
        "web_orders.fulfill",
    }


# --- store selection -------------------------------------------------------------


def test_member_of_a_selecting_b_is_403_like_a_missing_store(client, make_tenant):
    a, b = make_tenant("A"), make_tenant("B")
    h = headers(a, actor="only-in-a")
    assert client.get("/v1/inventory", headers=h).status_code == 200
    as_b = client.get("/v1/inventory", headers={**h, "X-Tenant-Id": str(b["id"])})
    nowhere = client.get("/v1/inventory", headers={**h, "X-Tenant-Id": str(uuid.uuid4())})
    assert as_b.status_code == nowhere.status_code == 403
    assert as_b.json() == nowhere.json() == {"detail": "you are not a member of that store"}
    # Writes too, and nothing lands in B.
    resp = client.post(
        "/v1/inventory/adjust", json=adjust_body(b), headers={**h, "X-Tenant-Id": str(b["id"])}
    )
    assert resp.status_code == 403


def test_unknown_user_is_403(client, make_tenant):
    t = make_tenant()
    resp = client.get(
        "/v1/inventory", headers={**bearer("never-joined"), "X-Tenant-Id": str(t["id"])}
    )
    assert resp.status_code == 403


def test_disabled_member_loses_access_immediately(client, make_tenant):
    t = make_tenant()
    h = headers(t, actor="soon-gone", role="cashier")
    assert client.get("/v1/inventory", headers=h).status_code == 200
    make_member(t, "soon-gone", "cashier", status="disabled")
    assert client.get("/v1/inventory", headers=h).status_code == 403
    make_member(t, "soon-gone", "cashier")
    assert client.get("/v1/inventory", headers=h).status_code == 200


def test_role_change_applies_on_the_next_request(client, make_tenant):
    t = make_tenant()
    h = headers(t, actor="promoted", role="cashier")
    resp = client.put(
        "/v1/pricing/rule",
        headers=h,
        json={
            "nm_bp": 10000,
            "lp_bp": 9000,
            "mp_bp": 7500,
            "hp_bp": 6000,
            "dmg_bp": 4000,
            "min_price_cents": 25,
            "round_up_to_cents": 25,
        },
    )
    assert resp.status_code == 403
    assert resp.json() == {"detail": {"missing": "pricing.rules_manage"}}
    make_member(t, "promoted", "manager")
    assert client.get("/v1/storefront-settings", headers=h).status_code == 404  # allowed now


def test_request_gucs_identify_the_principal(client, make_tenant):
    """The transaction's app.* settings come from the resolved principal."""
    from tcg_pos_api.auth import principal as principal_mod

    t = make_tenant()
    h = headers(t, actor="guc-check", role="cashier")
    gen = principal_mod._tenant_session(h["Authorization"], str(t["id"]), None)
    session = next(gen)
    seen = session.conn.execute(
        "SELECT current_user AS role, current_setting('app.tenant_id') AS tenant, "
        "current_setting('app.user_id') AS user_id, "
        "current_setting('app.actor') AS actor, current_setting('app.perms') AS perms"
    ).fetchone()
    gen.close()
    user = user_id_for("guc-check")
    assert seen == {
        "role": "tcg_pos_app",
        "tenant": str(t["id"]),
        "user_id": str(user),
        "actor": f"user:{user}",
        "perms": "credit.read,customers.read,inventory.read,pos.discount,pos.sell,"
        "web_orders.fulfill,web_orders.read",
    }


# --- raw SQL as the app role ------------------------------------------------------


def test_app_role_cannot_read_users_or_invite_tokens(make_tenant):
    t = make_tenant()
    with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("SELECT * FROM app_user")
    with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("SELECT token_hash FROM invite")
    with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "INSERT INTO membership (user_id, role_id) "
            "SELECT gen_random_uuid(), id FROM role LIMIT 1"
        )
    with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("DELETE FROM membership")


def test_app_role_with_a_gucs_sees_no_b_memberships(client, make_tenant):
    a, b = make_tenant("A"), make_tenant("B")
    headers(a, actor="a-member")
    headers(b, actor="b-member")
    with app_conn(a["id"], actor=actor_of("a-member")) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id_for("a-member")),))
        rows = conn.execute("SELECT tenant_id, user_id FROM membership").fetchall()
        assert {r["tenant_id"] for r in rows} == {a["id"]}
        assert user_id_for("b-member") not in {r["user_id"] for r in rows}
        staff = conn.execute("SELECT user_id FROM tenant_staff()").fetchall()
        assert user_id_for("b-member") not in {r["user_id"] for r in staff}
        # Promoting yourself in B: the row is invisible, nothing changes.
        cur = conn.execute(
            "UPDATE membership SET status = 'disabled' WHERE tenant_id = %s", (b["id"],)
        )
        assert cur.rowcount == 0


# --- the database owns the actor ---------------------------------------------------

ACTOR_INSERTS = {
    "audit_log": "INSERT INTO audit_log (action, entity{col}) VALUES ('x', 'y'{val})",
    "inventory_ledger": (
        "INSERT INTO inventory_ledger (inventory_item_id, delta, reason, channel{col}) "
        "SELECT id, 1, 'x', 'adjustment'{val} FROM inventory_item LIMIT 1"
    ),
    "credit_ledger": (
        "INSERT INTO credit_ledger (customer_id, delta_cents, reason{col}) "
        "SELECT id, 1, 'x'{val} FROM customer LIMIT 1"
    ),
    "buylist": ("INSERT INTO buylist (location_id{col}) SELECT id{val} FROM location LIMIT 1"),
}


@pytest.fixture
def stocked(client, make_tenant):
    t = make_tenant()
    client.post("/v1/inventory/adjust", json=adjust_body(t), headers=headers(t))
    return t


@pytest.mark.parametrize("table", ACTOR_INSERTS)
def test_forged_actor_is_rejected(stocked, table):
    col = "created_by" if table == "buylist" else "actor"
    sql = ACTOR_INSERTS[table]
    me = "user:00000000-0000-0000-0000-000000000001"
    # The default stamps the session's actor.
    with app_conn(stocked["id"], actor=me) as conn:
        conn.execute(sql.format(col="", val=""))
        assert (
            conn.execute(f"SELECT {col} AS a FROM {table} ORDER BY ctid DESC LIMIT 1").fetchone()[
                "a"
            ]
            == me
        )
    # Naming yourself explicitly is fine; naming anyone else is not.
    with app_conn(stocked["id"], actor=me) as conn:
        conn.execute(sql.format(col=f", {col}", val=f", '{me}'"))
    with (
        app_conn(stocked["id"], actor=me) as conn,
        pytest.raises(psycopg.errors.InsufficientPrivilege, match="actor"),
    ):
        conn.execute(sql.format(col=f", {col}", val=", 'user:someone-else'"))
    # No app.actor at all: rejected, even with an explicit value.
    with (
        app_conn(stocked["id"]) as conn,
        pytest.raises(psycopg.errors.InsufficientPrivilege, match="actor"),
    ):
        conn.execute(sql.format(col=f", {col}", val=f", '{me}'"))


@pytest.mark.parametrize("table", ["audit_log", "inventory_ledger", "credit_ledger"])
def test_forged_approver_is_rejected(stocked, table):
    me = "user:00000000-0000-0000-0000-000000000001"
    approver = user_id_for("some-manager")
    sql = ACTOR_INSERTS[table].format(col=", approved_by", val=f", '{approver}'")
    with (
        app_conn(stocked["id"], actor=me) as conn,
        pytest.raises(psycopg.errors.InsufficientPrivilege, match="approver"),
    ):
        conn.execute(sql)
    with app_conn(stocked["id"], actor=me) as conn:
        conn.execute("SELECT set_config('app.approved_by', %s, true)", (str(approver),))
        conn.execute(ACTOR_INSERTS[table].format(col="", val=""))
        row = conn.execute(f"SELECT approved_by FROM {table} ORDER BY ctid DESC LIMIT 1").fetchone()
        assert row["approved_by"] == approver


def test_api_writes_carry_the_verified_user(client, make_tenant, admin_conn):
    t = make_tenant()
    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t),
        headers={**headers(t, actor="real-clerk"), "X-Actor": "someone-else"},
    )
    assert resp.status_code == 200
    rows = admin_conn.execute(
        "SELECT actor FROM inventory_ledger WHERE tenant_id = %s UNION ALL "
        "SELECT actor FROM audit_log WHERE tenant_id = %s",
        (t["id"], t["id"]),
    ).fetchall()
    assert {r["actor"] for r in rows} == {actor_of("real-clerk")}


# --- /v1/me and onboarding -----------------------------------------------------------


def test_me_creates_the_user_and_lists_stores(client, make_tenant):
    resp = client.get("/v1/me", headers=bearer("Newcomer"))
    assert resp.status_code == 200, resp.text
    me = resp.json()
    assert me["user"]["email"] == "newcomer@example.test" and me["stores"] == []
    assert me["user"]["id"] == str(user_id_for("Newcomer"))

    t = make_tenant("Corner Store")
    headers(t, actor="Newcomer", role="cashier")
    stores = client.get("/v1/me", headers=bearer("Newcomer")).json()["stores"]
    assert stores == [
        {
            "tenant_id": str(t["id"]),
            "name": "Corner Store",
            "role": "cashier",
            "role_name": "Cashier",
        }
    ]
    make_member(t, "Newcomer", "cashier", status="disabled")
    assert client.get("/v1/me", headers=bearer("Newcomer")).json()["stores"] == []
    assert client.get("/v1/me").status_code == 401


def test_create_store_makes_the_caller_owner(client, admin_conn):
    h = bearer("founder")
    resp = client.post(
        "/v1/stores", json={"name": "  Dragon's Hoard ", "location_name": "Main"}, headers=h
    )
    assert resp.status_code == 201, resp.text
    store = resp.json()
    assert store["name"] == "Dragon's Hoard" and store["role"] == "owner"
    tenant = store["tenant_id"]
    # The new owner can use it straight away; nobody else can.
    sel = {**h, "X-Tenant-Id": tenant}
    assert client.get("/v1/inventory", headers=sel).json()["total"] == 0
    assert client.get("/v1/staff", headers=sel).json()[0]["role"] == "owner"
    assert (
        client.get(
            "/v1/inventory", headers={**bearer("stranger"), "X-Tenant-Id": tenant}
        ).status_code
        == 403
    )
    loc = admin_conn.execute("SELECT name FROM location WHERE tenant_id = %s", (tenant,)).fetchall()
    assert [r["name"] for r in loc] == ["Main"]
    audit = admin_conn.execute(
        "SELECT actor, action FROM audit_log WHERE tenant_id = %s", (tenant,)
    ).fetchall()
    assert [(a["actor"], a["action"]) for a in audit] == [(actor_of("founder"), "store.create")]
    for bad in ({"name": ""}, {"name": "x" * 101}, {"name": "ok", "extra": 1}):
        assert client.post("/v1/stores", json=bad, headers=h).status_code == 422


def test_last_owner_trigger_backstops_the_api(make_tenant, admin_conn):
    t = make_tenant()
    owner = make_member(t, "sole-owner", "owner")
    with pytest.raises(psycopg.errors.CheckViolation, match="no active owner"):
        admin_conn.execute(
            "UPDATE membership SET status = 'disabled' WHERE user_id = %s AND tenant_id = %s",
            (owner, t["id"]),
        )
    with pytest.raises(psycopg.errors.CheckViolation, match="no active owner"):
        admin_conn.execute(
            "UPDATE membership SET role_id = (SELECT id FROM role WHERE key = 'manager') "
            "WHERE user_id = %s AND tenant_id = %s",
            (owner, t["id"]),
        )
    make_member(t, "second-owner", "owner")
    admin_conn.execute(
        "UPDATE membership SET status = 'disabled' WHERE user_id = %s AND tenant_id = %s",
        (owner, t["id"]),
    )


def test_membership_role_must_belong_to_the_store(make_tenant, admin_conn):
    a, b = make_tenant("A"), make_tenant("B")
    role = admin_conn.execute(
        "INSERT INTO role (tenant_id, key, name) VALUES (%s, 'custom', 'Custom') RETURNING id",
        (b["id"],),
    ).fetchone()["id"]
    with pytest.raises(psycopg.errors.ForeignKeyViolation, match="not available"):
        admin_conn.execute(
            "INSERT INTO membership (tenant_id, user_id, role_id) VALUES (%s, %s, %s)",
            (a["id"], user_id_for("cross-role"), role),
        )


def test_store_roles_cannot_reuse_system_keys(make_tenant, admin_conn):
    t = make_tenant()
    for key in ("owner", "manager", "buyer", "cashier"):
        with pytest.raises(psycopg.errors.CheckViolation):
            admin_conn.execute(
                "INSERT INTO role (tenant_id, key, name) VALUES (%s, %s, 'Fake')", (t["id"], key)
            )
