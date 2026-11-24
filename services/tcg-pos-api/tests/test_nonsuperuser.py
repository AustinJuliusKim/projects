"""Migrations and the auth flow with tables owned by a NON-superuser role.

The rest of the suite migrates as the TEST_DATABASE_URL user, a superuser,
which bypasses RLS and owns everything — so it can't show that the SECURITY
DEFINER functions (create_store, accept_invite, resolve_register, ...) and
FORCE ROW LEVEL SECURITY still work when the owner is an ordinary role. On
Supabase the migrating role (`postgres`) is NOT a superuser and has no
BYPASSRLS; this mirrors it: a fresh database owned by a LOGIN role with
CREATEROLE only, migrated as that role, then the API pointed at it for one
end-to-end pass (store creation, PINs, register enrollment, invites,
approvals, the lockout, session ending and the last-owner guard).

Skipped without TEST_DATABASE_URL. Creates and drops `<test db>_nonsuper`
and the role `tcg_pos_nonsuper_owner` (cluster-wide, kept between runs)."""

import logging
import os
import re
import subprocess
import sys
import uuid

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row

from conftest import SERVICE_DIR, TEST_DATABASE_URL, bearer, mint, requires_db
from test_identity import id_token, sync

pytestmark = requires_db

ROLE = "tcg_pos_nonsuper_owner"
PASSWORD = "tcg_pos_nonsuper_owner"


def _admin():
    return psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row)


@pytest.fixture(scope="module")
def nonsuper_url(migrated_db):
    dbname = conninfo_to_dict(TEST_DATABASE_URL)["dbname"] + "_nonsuper"
    with _admin() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
        if c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,)).fetchone() is None:
            c.execute(f"CREATE ROLE {ROLE} LOGIN PASSWORD '{PASSWORD}'")
        # Like Supabase's `postgres`: may create roles, isn't a superuser,
        # doesn't bypass RLS. tcg_pos_app already exists in this cluster
        # (the main test database created it), so grant it the way the role
        # that creates it would hold it.
        c.execute(f"ALTER ROLE {ROLE} NOSUPERUSER NOBYPASSRLS CREATEROLE")
        c.execute(f"GRANT tcg_pos_app TO {ROLE}")
        c.execute(f'CREATE DATABASE "{dbname}" OWNER {ROLE}')
    url = make_conninfo(TEST_DATABASE_URL, dbname=dbname, user=ROLE, password=PASSWORD)
    with psycopg.connect(url, row_factory=dict_row) as c:
        me = c.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
    assert me == {"rolsuper": False, "rolbypassrls": False}
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py"],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": url},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    yield url
    with _admin() as c:
        c.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')


def _owner_conn(url, tenant_id=None, *, app=False):
    """A connection as the (non-superuser) owning role, optionally scoped to
    a store, optionally dropped to the app role."""
    conn = psycopg.connect(url, row_factory=dict_row)
    if app:
        conn.execute("SET LOCAL ROLE tcg_pos_app")
    if tenant_id:
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
    return conn


def test_migrations_and_auth_flow_as_a_non_superuser_owner(
    client, nonsuper_url, monkeypatch, caplog
):
    monkeypatch.setenv("DATABASE_URL", nonsuper_url)
    monkeypatch.setenv("REGISTER_PIN_LIMIT", "1000")
    caplog.set_level(logging.INFO, logger="tcg_pos_api.invites")
    tag = uuid.uuid4().hex[:8]

    # Every table is owned by the non-superuser, with RLS forced where it should be.
    with _owner_conn(nonsuper_url) as c:
        owners = c.execute(
            "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'"
        ).fetchall()
        assert owners == [{"tableowner": ROLE}]

    # Onboarding (create_store: definer, writes under FORCE RLS).
    owner = bearer(f"ns-owner-{tag}")
    resp = client.post("/v1/stores", json={"name": "Nonsuper"}, headers=owner)
    assert resp.status_code == 201, resp.text
    tenant = resp.json()["tenant_id"]
    me = client.get("/v1/me", headers=owner).json()
    assert [s["tenant_id"] for s in me["stores"]] == [tenant]
    oh = {**owner, "X-Tenant-Id": tenant}
    assert client.put("/v1/me/pin", json={"pin": "284716"}, headers=oh).status_code == 204

    with _owner_conn(nonsuper_url, tenant) as c:
        location = c.execute("SELECT id FROM location").fetchone()["id"]
        customer = c.execute("INSERT INTO customer (name) VALUES ('Pat') RETURNING id").fetchone()[
            "id"
        ]
        c.commit()

    # Registers and enrollment.
    reg = client.post(
        "/v1/registers", json={"location_id": str(location), "name": "Front"}, headers=oh
    ).json()
    device = client.post(f"/v1/registers/{reg['id']}/enroll", headers=oh).json()
    dh = {"Authorization": f"Device {device['device_secret']}"}

    # Invite a cashier; they prove their email with an ID token and accept.
    email = f"ns-cash-{tag}@example.test"
    assert (
        client.post("/v1/invites", json={"email": email, "role": "cashier"}, headers=oh).status_code
        == 201
    )
    token = re.search(r"token=(\S+)", caplog.records[-1].getMessage()).group(1)
    cash_sub = f"cognito|{uuid.uuid4()}"

    cash = {"Authorization": f"Bearer {mint(cash_sub)}"}
    assert sync(client, cash, id_token(cash_sub, email=email)).status_code == 200
    resp = client.post("/v1/invites/accept", json={"token": token}, headers=cash)
    assert resp.status_code == 200, resp.text
    ch = {**cash, "X-Tenant-Id": tenant}
    assert client.put("/v1/me/pin", json={"pin": "461938"}, headers=ch).status_code == 204

    # The register (resolve_register: definer) and PIN sign-in.
    staff = client.get("/v1/register/staff", headers=dh).json()
    by_role = {s["role"]: s["user_id"] for s in staff}
    assert set(by_role) == {"owner", "cashier"}
    resp = client.post(
        "/v1/register/sessions", json={"user_id": by_role["cashier"], "pin": "461938"}, headers=dh
    )
    assert resp.status_code == 201, resp.text
    sh = {**dh, "X-Register-Session": resp.json()["session_token"]}

    # Ledger writes stamp the actor (trigger) as the app role; an approval.
    url = f"/v1/customers/{customer}/credit"
    assert (
        client.post(
            f"{url}/issue", json={"amount_cents": 5000, "reason": "seed"}, headers=oh
        ).status_code
        == 200
    )
    need = client.post(f"{url}/adjust", json={"delta_cents": -500, "reason": "fix"}, headers=sh)
    detail = need.json()["detail"]
    assert detail["summary"]["title"] == "Remove $5.00 store credit"
    approval = client.post(
        "/v1/approvals",
        json={
            "perm": "credit.adjust",
            "payload_hash": detail["payload_hash"],
            "amount_cents": 500,
            "approver_user_id": by_role["owner"],
            "pin": "284716",
        },
        headers=sh,
    )
    assert approval.status_code == 201, approval.text
    resp = client.post(
        f"{url}/adjust",
        json={"delta_cents": -500, "reason": "fix"},
        headers={**sh, "X-Approval": approval.json()["approval_id"]},
    )
    assert resp.status_code == 200 and resp.json()["balance_cents"] == 4500
    # The owner's PIN on a register is not an admin.
    resp = client.post(
        "/v1/register/sessions", json={"user_id": by_role["owner"], "pin": "284716"}, headers=dh
    )
    owner_reg = {**dh, "X-Register-Session": resp.json()["session_token"]}
    assert client.get("/v1/api-keys", headers=owner_reg).status_code == 403

    # Per-device lockout rows (0015) as the app role.
    for _ in range(5):
        resp = client.post(
            "/v1/register/sessions",
            json={"user_id": by_role["owner"], "pin": "999990"},
            headers=dh,
        )
    assert resp.status_code == 423 and resp.json()["detail"]["scope"] == "device"

    # Disabling the cashier ends their register session (trigger).
    assert client.delete(f"/v1/staff/{by_role['cashier']}", headers=oh).status_code == 200
    resp = client.get("/v1/inventory", headers=sh)
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "session_ended"

    # The last-owner guard holds for the app role.
    with _owner_conn(nonsuper_url, tenant, app=True) as c:
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute(
                "UPDATE membership SET status = 'disabled' WHERE user_id = %s",
                (by_role["owner"],),
            )
    # And FORCE RLS binds the owning role itself: unscoped, it sees no store rows
    # (except through the definer_read policies the definer functions use).
    with _owner_conn(nonsuper_url) as c:
        for table in ("location", "credit_ledger", "staff_pin", "staff_pin_device", "approval"):
            assert c.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0, table
