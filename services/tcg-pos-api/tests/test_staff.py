"""Staff, invites and roles (A2): the invite flow end to end and the
escalation rules. Skipped without TEST_DATABASE_URL."""

import logging
import re
import uuid

import pytest

from conftest import (
    actor_of,
    app_conn,
    bearer,
    headers,
    make_member,
    requires_db,
    user_id_for,
)

pytestmark = requires_db


@pytest.fixture
def invite_links(caplog):
    """Accept tokens, as logged in place of an email (ENV=test)."""
    caplog.set_level(logging.INFO, logger="tcg_pos_api.invites")

    def tokens():
        return [
            re.search(r"token=(\S+)", r.getMessage()).group(1)
            for r in caplog.records
            if r.name == "tcg_pos_api.invites"
        ]

    return tokens


@pytest.fixture
def store(client, make_tenant):
    """A store with an owner (boss) and a manager (mgr)."""
    t = make_tenant("Staffed")
    t["owner"] = headers(t, actor="boss")
    t["manager"] = headers(t, actor="mgr", role="manager")
    return t


def _invite(client, h, email, role="cashier"):
    return client.post("/v1/invites", json={"email": email, "role": role}, headers=h)


def _accept(client, name, token):
    return client.post("/v1/invites/accept", json={"token": token}, headers=bearer(name))


# --- invites ---------------------------------------------------------------------


def test_invite_accept_flow(client, store, invite_links, admin_conn):
    email = f"new-{uuid.uuid4().hex[:8]}@example.test"
    resp = _invite(client, store["owner"], f"  {email.upper()} ")
    assert resp.status_code == 201, resp.text
    invite = resp.json()
    assert invite["email"] == email and invite["role"] == "cashier"
    assert invite["status"] == "pending" and invite["invited_by"] == str(user_id_for("boss"))
    (token,) = invite_links()
    assert token not in str(admin_conn.execute("SELECT * FROM invite").fetchall())  # hash only

    resp = _accept(client, email, token)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"tenant_id": str(store["id"]), "role": "cashier"}
    stores = client.get("/v1/me", headers=bearer(email)).json()["stores"]
    assert [s["tenant_id"] for s in stores] == [str(store["id"])]
    # They can work in the store now, as a cashier.
    sel = {**bearer(email), "X-Tenant-Id": str(store["id"])}
    assert client.get("/v1/inventory", headers=sel).status_code == 200
    assert client.get("/v1/staff", headers=sel).status_code == 403

    listed = client.get("/v1/invites", headers=store["owner"]).json()
    assert [(i["id"], i["status"], i["accepted_by"]) for i in listed] == [
        (invite["id"], "accepted", str(user_id_for(email)))
    ]
    staff = {s["email"]: s for s in client.get("/v1/staff", headers=store["owner"]).json()}
    assert staff[email]["role"] == "cashier" and staff[email]["status"] == "active"
    assert staff[email]["invited_by"] == str(user_id_for("boss"))

    # Single use.
    assert _accept(client, email, token).status_code == 409
    audit = admin_conn.execute(
        "SELECT actor, action FROM audit_log WHERE tenant_id = %s AND action LIKE 'invite.%%' "
        "ORDER BY at",
        (store["id"],),
    ).fetchall()
    assert [(a["actor"], a["action"]) for a in audit] == [
        (actor_of("boss"), "invite.create"),
        (actor_of(email), "invite.accept"),
    ]


def test_invite_email_must_match_the_verified_email(client, store, invite_links):
    _invite(client, store["owner"], "right@example.test")
    (token,) = invite_links()
    resp = _accept(client, "wrong@example.test", token)
    assert resp.status_code == 403 and "different email" in resp.json()["detail"]
    # A token without an email claim (a Cognito access token) can't accept
    # until the user's email is known.
    resp = client.post(
        "/v1/invites/accept", json={"token": token}, headers=bearer("no-email-user", email=None)
    )
    assert resp.status_code == 403
    # The right person still can.
    assert _accept(client, "right@example.test", token).status_code == 200


def test_expired_revoked_and_unknown_invites(client, store, invite_links, admin_conn):
    _invite(client, store["owner"], "late@example.test")
    revoked = _invite(client, store["owner"], "gone@example.test").json()
    late_token, gone_token = invite_links()
    admin_conn.execute(
        "UPDATE invite SET expires_at = now() - interval '1 second' "
        "WHERE email = 'late@example.test'"
    )
    assert _accept(client, "late@example.test", late_token).status_code == 410

    resp = client.delete(f"/v1/invites/{revoked['id']}", headers=store["owner"])
    assert resp.status_code == 200 and resp.json()["status"] == "revoked"
    assert client.delete(f"/v1/invites/{revoked['id']}", headers=store["owner"]).status_code == 409
    assert _accept(client, "gone@example.test", gone_token).status_code == 410

    assert _accept(client, "late@example.test", "x" * 43).status_code == 404
    assert client.post("/v1/invites/accept", json={"token": late_token}).status_code == 401
    statuses = {
        i["email"]: i["status"] for i in client.get("/v1/invites", headers=store["owner"]).json()
    }
    assert statuses == {"late@example.test": "expired", "gone@example.test": "revoked"}
    # An expired invite doesn't block a new one.
    assert _invite(client, store["owner"], "late@example.test").status_code == 201


def test_invite_conflicts_and_validation(client, store, invite_links):
    assert _invite(client, store["owner"], "dup@example.test").status_code == 201
    assert _invite(client, store["owner"], "dup@example.test").status_code == 409
    headers(store, actor="member@example.test", role="cashier")
    assert _invite(client, store["owner"], "member@example.test").status_code == 409
    assert _invite(client, store["owner"], "not-an-email").status_code == 422
    assert _invite(client, store["owner"], "x@example.test", role="wizard").status_code == 422
    assert (
        client.post(
            "/v1/invites",
            json={"email": "x@example.test", "role": "cashier", "extra": 1},
            headers=store["owner"],
        ).status_code
        == 422
    )


def test_reinvited_disabled_member_is_reactivated(client, store, invite_links):
    headers(store, actor="returning@example.test", role="cashier")
    make_member(store, "returning@example.test", "cashier", status="disabled")
    assert (
        _invite(client, store["owner"], "returning@example.test", role="buyer").status_code == 201
    )
    (token,) = invite_links()
    assert _accept(client, "returning@example.test", token).json()["role"] == "buyer"
    staff = {s["email"]: s for s in client.get("/v1/staff", headers=store["owner"]).json()}
    assert (staff["returning@example.test"]["role"], staff["returning@example.test"]["status"]) == (
        "buyer",
        "active",
    )


def test_invites_are_tenant_scoped(client, store, make_tenant):
    other = make_tenant("Other")
    invite = _invite(client, store["owner"], "scoped@example.test").json()
    oh = headers(other, actor="other-boss")
    assert client.get("/v1/invites", headers=oh).json() == []
    assert client.delete(f"/v1/invites/{invite['id']}", headers=oh).status_code == 404


# --- escalation ------------------------------------------------------------------


def test_manager_cannot_grant_owner_or_more_than_they_have(client, store, admin_conn):
    resp = _invite(client, store["manager"], "would-be-owner@example.test", role="owner")
    assert resp.status_code == 403
    assert resp.json()["detail"]["reason"] == "only an owner can grant the owner role"
    # A same-store custom role holding a permission managers lack.
    admin_conn.execute(
        "WITH r AS (INSERT INTO role (tenant_id, key, name) VALUES (%s, 'billing', 'Billing') "
        "RETURNING id) INSERT INTO role_permission (role_id, perm) "
        "SELECT id, p FROM r, unnest(ARRAY['billing.manage', 'inventory.read']) p",
        (store["id"],),
    )
    resp = _invite(client, store["manager"], "biller@example.test", role="billing")
    assert resp.status_code == 403 and resp.json()["detail"]["missing"] == ["billing.manage"]
    assert _invite(client, store["owner"], "biller@example.test", role="billing").status_code == 201
    # Within their own permissions, managers can invite.
    assert _invite(client, store["manager"], "peer@example.test", role="manager").status_code == 201
    assert _invite(client, store["manager"], "clerk2@example.test").status_code == 201
    # Someone without staff.manage can't invite at all.
    cashier = headers(store, actor="plain-cashier", role="cashier")
    assert _invite(client, cashier, "x@example.test").json() == {
        "detail": {"missing": "staff.manage"}
    }


def test_manager_cannot_touch_owners_or_owner_invites(client, store):
    boss = str(user_id_for("boss"))
    for method, kwargs in (("PATCH", {"json": {"role": "cashier"}}), ("DELETE", {})):
        resp = client.request(method, f"/v1/staff/{boss}", headers=store["manager"], **kwargs)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"]["reason"] == "only an owner can manage the owner role"
    owner_invite = _invite(client, store["owner"], "co-owner@example.test", role="owner").json()
    resp = client.delete(f"/v1/invites/{owner_invite['id']}", headers=store["manager"])
    assert resp.status_code == 403
    # Promoting a cashier to owner is an owner grant too.
    clerk = make_member(store, "clerk-x", "cashier")
    resp = client.patch(f"/v1/staff/{clerk}", json={"role": "owner"}, headers=store["manager"])
    assert resp.status_code == 403


def test_nobody_edits_their_own_membership(client, store):
    for who, name in ((store["owner"], "boss"), (store["manager"], "mgr")):
        me = user_id_for(name)
        for method, kwargs in (
            ("PATCH", {"json": {"role": "owner"}}),
            ("DELETE", {}),
            ("PATCH", {"json": {"status": "disabled"}}),
        ):
            resp = client.request(method, f"/v1/staff/{me}", headers=who, **kwargs)
            assert resp.status_code == 403
            assert resp.json()["detail"]["reason"] == "you can't change your own membership"


def test_owner_changes_roles_and_access_follows(client, store, admin_conn):
    clerk = make_member(store, "rising", "cashier")
    ch = {**bearer("rising"), "X-Tenant-Id": str(store["id"])}
    assert client.get("/v1/staff", headers=ch).status_code == 403
    resp = client.patch(f"/v1/staff/{clerk}", json={"role": "manager"}, headers=store["owner"])
    assert resp.status_code == 200 and resp.json()["role"] == "manager"
    assert client.get("/v1/staff", headers=ch).status_code == 200
    # Disable (DELETE) then re-enable (PATCH status).
    resp = client.delete(f"/v1/staff/{clerk}", headers=store["owner"])
    assert resp.status_code == 200 and resp.json()["status"] == "disabled"
    assert client.get("/v1/inventory", headers=ch).status_code == 403
    resp = client.patch(f"/v1/staff/{clerk}", json={"status": "active"}, headers=store["owner"])
    assert resp.json()["status"] == "active"
    assert client.get("/v1/inventory", headers=ch).status_code == 200
    # No-op change writes nothing.
    client.patch(f"/v1/staff/{clerk}", json={"status": "active"}, headers=store["owner"])
    audit = admin_conn.execute(
        "SELECT actor, before, after FROM audit_log WHERE action = 'staff.update' "
        "AND entity_id = %s ORDER BY at",
        (clerk,),
    ).fetchall()
    assert [(a["actor"], a["before"], a["after"]) for a in audit] == [
        (
            actor_of("boss"),
            {"role": "cashier", "status": "active"},
            {"role": "manager", "status": "active"},
        ),
        (
            actor_of("boss"),
            {"role": "manager", "status": "active"},
            {"role": "manager", "status": "disabled"},
        ),
        (
            actor_of("boss"),
            {"role": "manager", "status": "disabled"},
            {"role": "manager", "status": "active"},
        ),
    ]
    assert (
        client.patch(
            f"/v1/staff/{uuid.uuid4()}", json={"status": "active"}, headers=store["owner"]
        ).status_code
        == 404
    )
    assert (
        client.patch(
            f"/v1/staff/{clerk}", json={"role": "wizard"}, headers=store["owner"]
        ).status_code
        == 422
    )


def test_owners_can_demote_each_other_but_never_the_last(client, store):
    second = make_member(store, "second-boss", "owner")
    resp = client.patch(f"/v1/staff/{second}", json={"role": "manager"}, headers=store["owner"])
    assert resp.status_code == 200
    # Now boss is the only owner: the demoted one can't touch them, and the
    # database refuses to leave the store ownerless (tests/test_auth_db.py).
    sh = {**bearer("second-boss"), "X-Tenant-Id": str(store["id"])}
    boss = user_id_for("boss")
    assert client.delete(f"/v1/staff/{boss}", headers=sh).status_code == 403


def test_api_refuses_to_remove_the_last_owner(make_tenant):
    """The route's own last-owner check. Through HTTP it sits behind the
    self-edit and owner-only rules (an owner can't be the last owner while
    another owner is acting), so drive it directly with an owner principal
    who isn't a member row, i.e. the state a race would leave."""
    from fastapi import HTTPException

    from tcg_pos_api.auth import Perm, Principal, TenantSession
    from tcg_pos_api.routes.staff import _change_member

    t = make_tenant()
    sole = make_member(t, "sole-owner-api", "owner")
    principal = Principal(
        user_id=uuid.uuid4(),
        tenant_id=t["id"],
        role_key="owner",
        perms=frozenset(p.value for p in Perm),
        location_ids=None,
        actor="user:racer",
    )
    for change in (
        {"role_key": "manager", "status": None},
        {"role_key": None, "status": "disabled"},
    ):
        with (
            app_conn(t["id"], actor="user:racer") as conn,
            pytest.raises(HTTPException) as exc,
        ):
            _change_member(TenantSession(conn, principal), sole, **change)
        assert exc.value.status_code == 409


def test_roles_list(client, store, make_tenant, admin_conn):
    other = make_tenant("Other")
    admin_conn.execute(
        "INSERT INTO role (tenant_id, key, name) VALUES (%s, 'secret', 'Secret')", (other["id"],)
    )
    roles = client.get("/v1/roles", headers=store["manager"]).json()
    assert [r["key"] for r in roles] == ["owner", "manager", "buyer", "cashier"]
    assert len(roles[0]["perms"]) == 32 and all(r["is_system"] for r in roles)
    assert "billing.manage" not in roles[1]["perms"]
