"""Store API keys (A4): creation rules, ApiKey auth, revocation.
Skipped without TEST_DATABASE_URL."""

import pytest

from conftest import adjust_body, bearer, headers, make_member, requires_db

pytestmark = requires_db


@pytest.fixture
def store(client, make_tenant):
    t = make_tenant("Keyed")
    t["owner"] = headers(t, actor="key-owner")
    return t


def create_key(client, store, perms, name="sync", h=None):
    return client.post(
        "/v1/api-keys", json={"name": name, "perms": perms}, headers=h or store["owner"]
    )


def key_h(key):
    return {"Authorization": f"ApiKey {key}"}


def test_create_use_and_revoke_a_key(client, store, admin_conn):
    resp = create_key(client, store, ["inventory.read", "inventory.adjust"])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    key = body["key"]
    assert key.startswith(f"tcgpos_{body['prefix']}_")
    assert body["perms"] == ["inventory.adjust", "inventory.read"] and body["status"] == "active"
    stored = admin_conn.execute(
        "SELECT secret_hash, created_by FROM api_key WHERE id = %s", (body["id"],)
    ).fetchone()
    assert key.split("_", 2)[2] not in stored["secret_hash"]
    assert str(stored["created_by"]) == body["created_by"]

    # The key decides the store; X-Tenant-Id is optional.
    assert client.get("/v1/inventory", headers=key_h(key)).status_code == 200
    resp = client.post("/v1/inventory/adjust", json=adjust_body(store), headers=key_h(key))
    assert resp.status_code == 200, resp.text
    actor = admin_conn.execute(
        "SELECT actor FROM inventory_ledger WHERE id = %s", (resp.json()["ledger_id"],)
    ).fetchone()["actor"]
    assert actor == f"apikey:{body['id']}"
    # Only its own permissions.
    resp = client.get(f"/v1/customers/{store['customer_id']}/credit", headers=key_h(key))
    assert resp.status_code == 403 and resp.json() == {"detail": {"missing": "credit.read"}}
    used = client.get("/v1/api-keys", headers=store["owner"]).json()
    assert used[0]["last_used_at"] is not None and "key" not in used[0]

    resp = client.delete(f"/v1/api-keys/{body['id']}", headers=store["owner"])
    assert resp.status_code == 200 and resp.json()["status"] == "revoked"
    resp = client.get("/v1/inventory", headers=key_h(key))
    assert resp.status_code == 401 and resp.headers["www-authenticate"] == "ApiKey"
    assert client.delete(f"/v1/api-keys/{body['id']}", headers=store["owner"]).status_code == 409


def test_wrong_secret_or_malformed_key_is_401(client, store):
    key = create_key(client, store, ["inventory.read"]).json()["key"]
    prefix = key.split("_")[1]
    for bad in (
        f"tcgpos_{prefix}_" + "A" * 43,  # right prefix, wrong secret
        key[:-1],  # truncated secret
        "tcgpos_000000000000_" + "A" * 43,  # unknown prefix
        "tcgpos_nothex000000_" + "A" * 43,
        key.replace("tcgpos_", "tcgpoz_"),
        "",
    ):
        resp = client.get("/v1/inventory", headers=key_h(bad))
        assert resp.status_code == 401, bad


def test_key_perms_must_be_a_subset_of_the_creators(client, store, admin_conn):
    # An owner holds everything, but identity/admin perms are never for keys.
    resp = create_key(client, store, ["inventory.read", "staff.manage", "approve.override"])
    assert resp.status_code == 422
    assert resp.json()["detail"]["perms"] == ["approve.override", "staff.manage"]
    assert create_key(client, store, ["no.such"]).status_code == 422
    assert create_key(client, store, []).status_code == 422
    # A store role with apikeys.manage but not credit.issue can't hand it out.
    user = make_member(store, "keymaker", "owner")
    role = admin_conn.execute(
        "INSERT INTO role (tenant_id, key, name) VALUES (%s, 'integrator', 'Integrator') "
        "RETURNING id",
        (store["id"],),
    ).fetchone()["id"]
    admin_conn.execute(
        "INSERT INTO role_permission (role_id, perm) VALUES (%s, 'apikeys.manage'), "
        "(%s, 'inventory.read')",
        (role, role),
    )
    admin_conn.execute(
        "UPDATE membership SET role_id = %s WHERE tenant_id = %s AND user_id = %s",
        (role, store["id"], user),
    )
    h = {**bearer("keymaker"), "X-Tenant-Id": str(store["id"])}
    resp = create_key(client, store, ["inventory.read", "credit.issue"], h=h)
    assert resp.status_code == 403
    assert resp.json()["detail"]["missing"] == ["credit.issue"]
    assert create_key(client, store, ["inventory.read"], h=h).status_code == 201


def test_a_key_only_serves_its_own_store(client, store, make_tenant):
    key = create_key(client, store, ["inventory.read"]).json()["key"]
    other = make_tenant()
    assert (
        client.get(
            "/v1/inventory", headers={**key_h(key), "X-Tenant-Id": str(store["id"])}
        ).status_code
        == 200
    )
    resp = client.get("/v1/inventory", headers={**key_h(key), "X-Tenant-Id": str(other["id"])})
    assert resp.status_code == 403
    # And another store's owner can't see or revoke it.
    oh = headers(other, actor="other-key-owner")
    assert client.get("/v1/api-keys", headers=oh).json() == []
    kid = client.get("/v1/api-keys", headers=store["owner"]).json()[0]["id"]
    assert client.delete(f"/v1/api-keys/{kid}", headers=oh).status_code == 404


def test_keys_cant_reach_member_or_register_routes(client, store):
    key = create_key(client, store, ["inventory.read", "credit.adjust"]).json()["key"]
    assert client.put("/v1/me/pin", json={"pin": "284716"}, headers=key_h(key)).status_code == 403
    assert client.delete("/v1/register/sessions", headers=key_h(key)).status_code == 403
    assert client.get("/v1/me", headers=key_h(key)).status_code == 401
    # No role, so no approval policy: the plain permission decides.
    resp = client.post(
        f"/v1/customers/{store['customer_id']}/credit/adjust",
        json={"delta_cents": 100, "reason": "sync"},
        headers=key_h(key),
    )
    assert resp.status_code == 200, resp.text


def test_app_role_cannot_read_key_hashes(client, store):
    import psycopg

    from conftest import app_conn

    create_key(client, store, ["inventory.read"])
    with app_conn(store["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("SELECT secret_hash FROM api_key")
