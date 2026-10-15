"""Register devices, PINs, register sessions and manager approvals (A3).
Skipped without TEST_DATABASE_URL."""

import uuid

import pytest

from conftest import adjust_body, headers, make_member, requires_db, user_id_for

pytestmark = requires_db

PINS = {"boss": "284716", "mgr": "730291", "cash": "461938", "buy": "905173", "cash2": "318642"}


@pytest.fixture(autouse=True)
def _generous_pin_limit(monkeypatch):
    """Per-device PIN rate limiting gets its own test; elsewhere keep it out
    of the way."""
    monkeypatch.setenv("REGISTER_PIN_LIMIT", "1000")


def name_of(store, who):
    return f"{who}-{store['tag']}"


def staff_h(client, store, who, role):
    """Bearer headers for a member of `role`, with their PIN set."""
    h = headers(store, actor=name_of(store, who), role=role)
    resp = client.put("/v1/me/pin", json={"pin": PINS[who]}, headers=h)
    assert resp.status_code == 204, resp.text
    return h


@pytest.fixture
def store(client, make_tenant):
    t = make_tenant("Register Store")
    t["tag"] = uuid.uuid4().hex[:8]
    t["owner"] = staff_h(client, t, "boss", "owner")
    t["manager"] = staff_h(client, t, "mgr", "manager")
    t["cashier"] = staff_h(client, t, "cash", "cashier")
    t["uid"] = {w: user_id_for(name_of(t, w)) for w in ("boss", "mgr", "cash")}
    return t


def enroll(client, store, owner_h=None):
    owner_h = owner_h or store["owner"]
    reg = client.post(
        "/v1/registers",
        json={"location_id": str(store["location_id"]), "name": "Front"},
        headers=owner_h,
    )
    assert reg.status_code == 201, reg.text
    resp = client.post(f"/v1/registers/{reg.json()['id']}/enroll", headers=owner_h)
    assert resp.status_code == 201, resp.text
    return resp.json()


def device_h(device, token=None):
    h = {"Authorization": f"Device {device['device_secret']}"}
    if token:
        h["X-Register-Session"] = token
    return h


def sign_in(client, store, device, who, pin=None):
    return client.post(
        "/v1/register/sessions",
        json={"user_id": str(store["uid"][who]), "pin": pin or PINS[who]},
        headers=device_h(device),
    )


def session_h(client, store, device, who):
    resp = sign_in(client, store, device, who)
    assert resp.status_code == 201, resp.text
    return device_h(device, resp.json()["session_token"])


# --- PINs -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "pin",
    [
        "111111",
        "121212",
        "123123",
        "123456",
        "654321",
        "345678",
        "12345",
        "1234567",
        "12a456",
        " 28471",
    ],
)
def test_trivial_or_malformed_pins_are_refused(client, make_tenant, pin):
    t = make_tenant()
    resp = client.put("/v1/me/pin", json={"pin": pin}, headers=headers(t, actor="pinner"))
    assert resp.status_code == 422, resp.text


def test_pin_is_stored_as_argon2id(client, store, admin_conn):
    row = admin_conn.execute(
        "SELECT pin_hash, fail_count FROM staff_pin WHERE tenant_id = %s AND user_id = %s",
        (store["id"], store["uid"]["cash"]),
    ).fetchone()
    assert row["pin_hash"].startswith("$argon2id$") and PINS["cash"] not in row["pin_hash"]
    audit = admin_conn.execute(
        "SELECT actor FROM audit_log WHERE tenant_id = %s AND action = 'pin.set' "
        "AND entity_id = %s",
        (store["id"], store["uid"]["cash"]),
    ).fetchall()
    assert [a["actor"] for a in audit] == [f"user:{store['uid']['cash']}"]


def test_pin_is_set_with_a_bearer_token_not_a_register_session(client, store):
    device = enroll(client, store)
    h = session_h(client, store, device, "cash")
    resp = client.put("/v1/me/pin", json={"pin": "502938"}, headers=h)
    assert resp.status_code == 403
    assert resp.json() == {"detail": {"reason": "sign_in_required"}}


# --- enrollment and device auth ---------------------------------------------------


def test_enroll_sign_in_and_work_through_the_register(client, store, admin_conn):
    device = enroll(client, store)
    assert device["device_secret"].startswith("tcgdev_")
    assert device["device"]["status"] == "active"
    assert device["device"]["enrolled_by"] == str(store["uid"]["boss"])
    stored = admin_conn.execute(
        "SELECT secret_hash FROM register_device WHERE id = %s", (device["device"]["id"],)
    ).fetchone()
    assert device["device_secret"] not in stored["secret_hash"]

    # A member without a PIN, and a disabled one, aren't offered.
    make_member(store, name_of(store, "nopin"), "cashier")
    make_member(store, name_of(store, "cash2"), "cashier")
    client.put(
        "/v1/me/pin",
        json={"pin": PINS["cash2"]},
        headers=headers(store, actor=name_of(store, "cash2"), role="cashier"),
    )
    make_member(store, name_of(store, "cash2"), "cashier", status="disabled")
    staff = client.get("/v1/register/staff", headers=device_h(device))
    assert staff.status_code == 200, staff.text
    assert {(s["user_id"], s["role"]) for s in staff.json()} == {
        (str(store["uid"]["boss"]), "owner"),
        (str(store["uid"]["mgr"]), "manager"),
        (str(store["uid"]["cash"]), "cashier"),
    }

    resp = sign_in(client, store, device, "cash")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role"] == "cashier" and "pos.sell" in body["perms"]
    assert body["idle_timeout_seconds"] == 1800 and body["session_token"].startswith("tcgreg_")
    h = device_h(device, body["session_token"])

    assert client.get("/v1/inventory", headers=h).status_code == 200
    # The cashier's own permissions apply.
    resp = client.post("/v1/inventory/adjust", json=adjust_body(store), headers=h)
    assert resp.status_code == 403 and resp.json() == {"detail": {"missing": "inventory.adjust"}}

    # A manager through the same register writes as device/user.
    mh = session_h(client, store, device, "mgr")
    resp = client.post("/v1/inventory/adjust", json=adjust_body(store), headers=mh)
    assert resp.status_code == 200, resp.text
    actor = admin_conn.execute(
        "SELECT actor FROM inventory_ledger WHERE id = %s", (resp.json()["ledger_id"],)
    ).fetchone()["actor"]
    assert actor == f"device:{device['device']['id']}/user:{store['uid']['mgr']}"

    seen = admin_conn.execute(
        "SELECT d.last_seen_at IS NOT NULL AS dev, s.last_seen_at > s.created_at AS ses "
        "FROM register_device d JOIN register_session s ON s.device_id = d.id "
        "WHERE d.id = %s AND s.id = %s",
        (device["device"]["id"], body["session_id"]),
    ).fetchone()
    assert seen == {"dev": True, "ses": True}

    listed = client.get("/v1/registers/devices", headers=store["owner"]).json()
    assert [d["id"] for d in listed] == [device["device"]["id"]]


def test_device_requests_need_a_valid_device_and_session(client, store):
    device = enroll(client, store)
    assert client.get("/v1/inventory", headers=device_h(device)).json()["detail"]["reason"] == (
        "session_required"
    )
    resp = client.get("/v1/inventory", headers=device_h(device, "tcgreg_nope"))
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "session_invalid"
    bad = {"device_secret": "tcgdev_" + "x" * 43}
    resp = client.get("/v1/register/staff", headers=device_h(bad))
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "device_unknown"
    assert resp.headers["www-authenticate"] == "Device"
    # A bearer token is not a device credential.
    assert client.get("/v1/register/staff", headers=store["owner"]).status_code == 401


def test_a_device_only_serves_its_own_store(client, store, make_tenant):
    device = enroll(client, store)
    h = session_h(client, store, device, "mgr")
    other = make_tenant()
    assert (
        client.get("/v1/inventory", headers={**h, "X-Tenant-Id": str(store["id"])}).status_code
        == 200
    )
    resp = client.get("/v1/inventory", headers={**h, "X-Tenant-Id": str(other["id"])})
    assert resp.status_code == 403
    # Someone from another store can't sign in on this one's register.
    make_member(other, "outsider", "owner")
    resp = client.post(
        "/v1/register/sessions",
        json={"user_id": str(user_id_for("outsider")), "pin": "284716"},
        headers=device_h(device),
    )
    assert resp.status_code == 403 and resp.json()["detail"]["reason"] == "wrong_pin"


def test_enrolling_needs_a_register_of_the_store(client, store, make_tenant):
    other = make_tenant()
    other["tag"] = "x"
    reg = client.post(
        "/v1/registers",
        json={"location_id": str(other["location_id"]), "name": "Theirs"},
        headers=headers(other, actor="other-owner"),
    ).json()
    resp = client.post(f"/v1/registers/{reg['id']}/enroll", headers=store["owner"])
    assert resp.status_code == 404
    resp = client.post(
        "/v1/registers",
        json={"location_id": str(other["location_id"]), "name": "Sneaky"},
        headers=store["owner"],
    )
    assert resp.status_code == 422


# --- PIN lockout and rate limit -------------------------------------------------------


def _fails(admin_conn, store, user):
    return admin_conn.execute(
        "SELECT count(*) AS n FROM audit_log WHERE tenant_id = %s AND action = 'pin.fail' "
        "AND entity_id = %s",
        (store["id"], user),
    ).fetchone()["n"]


def _unlock_now(admin_conn, store, user):
    """Simulate the locks (store-wide and per device) running out."""
    for table in ("staff_pin", "staff_pin_device"):
        admin_conn.execute(
            f"UPDATE {table} SET locked_until = now() - interval '1 second' "
            "WHERE tenant_id = %s AND user_id = %s AND locked_until IS NOT NULL",
            (store["id"], user),
        )


def test_pin_lockout_doubles_and_unlocks(client, store, admin_conn):
    device = enroll(client, store)
    cash = store["uid"]["cash"]
    for left in (4, 3, 2, 1):
        resp = sign_in(client, store, device, "cash", pin="999990")
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == {"reason": "wrong_pin", "attempts_left": left}
    resp = sign_in(client, store, device, "cash", pin="999990")
    assert resp.status_code == 423
    assert resp.json()["detail"] == {"reason": "pin_locked", "retry_after": 60, "scope": "device"}
    assert resp.headers["retry-after"] == "60"
    # While locked even the right PIN is refused (and not checked).
    resp = sign_in(client, store, device, "cash")
    assert resp.status_code == 423 and 55 <= resp.json()["detail"]["retry_after"] <= 60
    assert _fails(admin_conn, store, cash) == 6
    locked = admin_conn.execute(
        "SELECT fail_count, round(extract(epoch FROM locked_until - now())) AS secs "
        "FROM staff_pin_device WHERE tenant_id = %s AND user_id = %s AND device_id = %s",
        (store["id"], cash, device["device"]["id"]),
    ).fetchone()
    assert locked["fail_count"] == 5 and 55 <= locked["secs"] <= 60

    # After the minute, one more miss locks for 2 minutes, then 4.
    _unlock_now(admin_conn, store, cash)
    resp = sign_in(client, store, device, "cash", pin="999990")
    assert resp.status_code == 423 and resp.json()["detail"]["retry_after"] == 120
    _unlock_now(admin_conn, store, cash)
    resp = sign_in(client, store, device, "cash", pin="999990")
    assert resp.json()["detail"]["retry_after"] == 240

    # Once unlocked the right PIN works and clears the count.
    _unlock_now(admin_conn, store, cash)
    assert sign_in(client, store, device, "cash").status_code == 201
    row = admin_conn.execute(
        "SELECT fail_count, locked_until FROM staff_pin WHERE tenant_id = %s AND user_id = %s",
        (store["id"], cash),
    ).fetchone()
    assert row == {"fail_count": 0, "locked_until": None}
    audit = admin_conn.execute(
        "SELECT actor, after FROM audit_log WHERE tenant_id = %s AND action = 'pin.fail' "
        "AND entity_id = %s ORDER BY at LIMIT 1",
        (store["id"], cash),
    ).fetchone()
    assert audit["actor"] == f"device:{device['device']['id']}"
    assert audit["after"]["purpose"] == "sign_in" and audit["after"]["reason"] == "wrong_pin"


def test_lock_caps_at_an_hour():
    from tcg_pos_api.auth.pins import lock_seconds, store_lock_seconds

    # The store-wide ceiling: never from one device, an hour per failure
    # from the 11th across two or more.
    assert [store_lock_seconds(n, 1) for n in (5, 11, 100)] == [0, 0, 0]
    assert [store_lock_seconds(n, 2) for n in (5, 10, 11, 12)] == [0, 0, 3600, 3600]

    assert [lock_seconds(n) for n in (1, 4, 5, 6, 7, 10, 11, 50)] == [
        0,
        0,
        60,
        120,
        240,
        1920,
        3600,
        3600,
    ]


def test_setting_a_new_pin_clears_a_lockout(client, store, admin_conn):
    device = enroll(client, store)
    for _ in range(5):
        sign_in(client, store, device, "cash", pin="999990")
    assert sign_in(client, store, device, "cash").status_code == 423
    resp = client.put("/v1/me/pin", json={"pin": "640273"}, headers=store["cashier"])
    assert resp.status_code == 204
    assert sign_in(client, store, device, "cash", pin="640273").status_code == 201


def test_pin_attempts_are_rate_limited_per_device(client, store, monkeypatch):
    monkeypatch.setenv("REGISTER_PIN_LIMIT", "3")
    device = enroll(client, store)
    codes = [sign_in(client, store, device, w).status_code for w in ("cash", "mgr", "boss")]
    assert codes == [201, 201, 201]
    resp = sign_in(client, store, device, "cash")
    assert resp.status_code == 429 and "retry-after" in resp.headers
    # Another device isn't affected.
    assert sign_in(client, store, enroll(client, store), "cash").status_code == 201


# --- revocation and expiry ------------------------------------------------------------


def test_revoked_device_kills_its_sessions(client, store, admin_conn):
    device = enroll(client, store)
    h = session_h(client, store, device, "mgr")
    assert client.get("/v1/inventory", headers=h).status_code == 200
    resp = client.delete(f"/v1/registers/devices/{device['device']['id']}", headers=store["owner"])
    assert resp.status_code == 200 and resp.json()["status"] == "revoked"
    resp = client.get("/v1/inventory", headers=h)
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "device_unknown"
    assert client.get("/v1/register/staff", headers=device_h(device)).status_code == 401
    assert sign_in(client, store, device, "cash").status_code == 401
    open_sessions = admin_conn.execute(
        "SELECT count(*) AS n FROM register_session WHERE device_id = %s AND ended_at IS NULL",
        (device["device"]["id"],),
    ).fetchone()["n"]
    assert open_sessions == 0
    resp = client.delete(f"/v1/registers/devices/{device['device']['id']}", headers=store["owner"])
    assert resp.status_code == 409


def test_sessions_idle_out_expire_and_sign_out(client, store, admin_conn):
    device = enroll(client, store)

    def open_session():
        resp = sign_in(client, store, device, "cash")
        return resp.json()["session_id"], device_h(device, resp.json()["session_token"])

    sid, h = open_session()
    admin_conn.execute(
        "UPDATE register_session SET last_seen_at = now() - interval '29 minutes' WHERE id = %s",
        (sid,),
    )
    assert client.get("/v1/inventory", headers=h).status_code == 200  # activity resets idle
    admin_conn.execute(
        "UPDATE register_session SET last_seen_at = now() - interval '31 minutes' WHERE id = %s",
        (sid,),
    )
    resp = client.get("/v1/inventory", headers=h)
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "session_idle"

    sid, h = open_session()
    admin_conn.execute(
        "UPDATE register_session SET expires_at = now() - interval '1 second' WHERE id = %s",
        (sid,),
    )
    resp = client.get("/v1/inventory", headers=h)
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "session_expired"

    sid, h = open_session()
    expires = admin_conn.execute(
        "SELECT round(extract(epoch FROM expires_at - created_at)) AS s FROM register_session "
        "WHERE id = %s",
        (sid,),
    ).fetchone()["s"]
    assert expires == 12 * 3600
    assert client.delete("/v1/register/sessions", headers=h).status_code == 204
    resp = client.get("/v1/inventory", headers=h)
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "session_ended"


def test_disabled_member_loses_their_register_session(client, store):
    device = enroll(client, store)
    h = session_h(client, store, device, "cash")
    make_member(store, name_of(store, "cash"), "cashier", status="disabled")
    # Even a change made straight in SQL ends the session (0015 trigger).
    resp = client.get("/v1/inventory", headers=h)
    assert resp.status_code == 401 and resp.json()["detail"]["reason"] == "session_ended"
    assert sign_in(client, store, device, "cash").status_code == 403


# --- approvals -------------------------------------------------------------------------


@pytest.fixture
def counter(client, store, admin_conn):
    """A register with the cashier signed in, and a customer with $50 credit."""
    admin_conn.execute(
        "INSERT INTO credit_ledger (tenant_id, customer_id, delta_cents, reason, actor) "
        "VALUES (%s, %s, 5000, 'seed', 'job:test')",
        (store["id"], store["customer_id"]),
    )
    device = enroll(client, store)
    return {
        "device": device,
        "cashier": session_h(client, store, device, "cash"),
        "url": f"/v1/customers/{store['customer_id']}/credit/adjust",
    }


def _approve(client, store, counter, needed, who="mgr", pin=None, h=None):
    return client.post(
        "/v1/approvals",
        json={
            "perm": needed["approval_required"],
            "payload_hash": needed["payload_hash"],
            "amount_cents": needed["amount_cents"],
            "approver_user_id": str(store["uid"][who]),
            "pin": pin or PINS[who],
        },
        headers=h or counter["cashier"],
    )


def _ask(client, counter, delta, h=None, approval=None):
    hh = dict(h or counter["cashier"])
    if approval:
        hh["X-Approval"] = approval
    return client.post(counter["url"], json={"delta_cents": delta, "reason": "fix"}, headers=hh)


def _balance(admin_conn, store):
    return admin_conn.execute(
        "SELECT balance_cents FROM customer_credit_balance WHERE customer_id = %s",
        (store["customer_id"],),
    ).fetchone()["balance_cents"]


def test_cashier_credit_adjust_with_manager_approval(client, store, counter, admin_conn):
    resp = _ask(client, counter, -500)
    assert resp.status_code == 403
    needed = resp.json()["detail"]
    assert needed["approval_required"] == "credit.adjust" and needed["amount_cents"] == 500
    assert _balance(admin_conn, store) == 5000

    approval = _approve(client, store, counter, needed)
    assert approval.status_code == 201, approval.text
    body = approval.json()
    assert body["approved_by"] == str(store["uid"]["mgr"])

    resp = _ask(client, counter, -500, approval=body["approval_id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["balance_cents"] == 4500
    row = admin_conn.execute(
        "SELECT actor, approved_by FROM credit_ledger WHERE customer_id = %s AND reason = 'fix'",
        (store["customer_id"],),
    ).fetchone()
    dev = counter["device"]["device"]["id"]
    assert row == {
        "actor": f"device:{dev}/user:{store['uid']['cash']}",
        "approved_by": store["uid"]["mgr"],
    }
    audit = admin_conn.execute(
        "SELECT approved_by FROM audit_log WHERE tenant_id = %s AND action = 'credit.adjust'",
        (store["id"],),
    ).fetchone()
    assert audit["approved_by"] == store["uid"]["mgr"]

    # Replay: single use.
    resp = _ask(client, counter, -500, approval=body["approval_id"])
    assert resp.status_code == 403 and resp.json()["detail"]["approval_error"] == "invalid"
    assert _balance(admin_conn, store) == 4500


def test_approval_is_bound_to_the_payload(client, store, counter, admin_conn):
    needed = _ask(client, counter, -500).json()["detail"]
    approval = _approve(client, store, counter, needed).json()["approval_id"]
    # A different amount, or a different reason, is a different request.
    resp = _ask(client, counter, -5000, approval=approval)
    assert resp.status_code == 403 and resp.json()["detail"]["approval_error"] == "invalid"
    resp = client.post(
        counter["url"],
        json={"delta_cents": -500, "reason": "other"},
        headers={**counter["cashier"], "X-Approval": approval},
    )
    assert resp.status_code == 403 and resp.json()["detail"]["approval_error"] == "invalid"
    # Still unused: the original request goes through.
    assert _ask(client, counter, -500, approval=approval).status_code == 200


def test_approval_expires_after_a_minute(client, store, counter, admin_conn):
    needed = _ask(client, counter, -500).json()["detail"]
    approval = _approve(client, store, counter, needed).json()
    ttl = admin_conn.execute(
        "SELECT round(extract(epoch FROM expires_at - created_at)) AS s FROM approval "
        "WHERE id = %s",
        (approval["approval_id"],),
    ).fetchone()["s"]
    assert ttl == 60
    admin_conn.execute(
        "UPDATE approval SET expires_at = now() - interval '1 second' WHERE id = %s",
        (approval["approval_id"],),
    )
    resp = _ask(client, counter, -500, approval=approval["approval_id"])
    assert resp.status_code == 403 and resp.json()["detail"]["approval_error"] == "invalid"


def test_approver_must_hold_the_perm_and_override(client, store, counter, admin_conn):
    needed = _ask(client, counter, -500).json()["detail"]
    store["uid"]["buy"] = make_member(store, name_of(store, "buy"), "buyer")
    staff_h(client, store, "buy", "buyer")
    store["uid"]["cash2"] = make_member(store, name_of(store, "cash2"), "cashier")
    staff_h(client, store, "cash2", "cashier")
    for who in ("buy", "cash2"):
        resp = _approve(client, store, counter, needed, who=who)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == {"reason": "approver_not_allowed", "perm": "credit.adjust"}
    # Self-approval is refused outright, even for someone who could approve.
    mh = session_h(client, store, counter["device"], "mgr")
    resp = _approve(client, store, counter, needed, who="mgr", h=mh)
    assert resp.status_code == 403 and resp.json()["detail"] == {"reason": "self_approval"}
    # A wrong approver PIN counts against the approver's PIN.
    resp = _approve(client, store, counter, needed, pin="999990")
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"reason": "wrong_pin", "attempts_left": 4}
    assert (
        admin_conn.execute(
            "SELECT count(*) AS n FROM approval WHERE tenant_id = %s", (store["id"],)
        ).fetchone()["n"]
        == 0
    )


def test_approver_losing_access_voids_the_approval(client, store, counter):
    needed = _ask(client, counter, -500).json()["detail"]
    approval = _approve(client, store, counter, needed).json()["approval_id"]
    make_member(store, name_of(store, "mgr"), "cashier")  # demoted within the minute
    resp = _ask(client, counter, -500, approval=approval)
    assert resp.status_code == 403 and resp.json()["detail"]["approval_error"] == "invalid"


def test_approval_is_bound_to_requester_and_device(client, store, counter):
    needed = _ask(client, counter, -500).json()["detail"]
    approval = _approve(client, store, counter, needed).json()["approval_id"]
    store["uid"]["cash2"] = make_member(store, name_of(store, "cash2"), "cashier")
    staff_h(client, store, "cash2", "cashier")
    other_user = session_h(client, store, counter["device"], "cash2")
    resp = _ask(client, counter, -500, h=other_user, approval=approval)
    assert resp.json()["detail"]["approval_error"] == "invalid"
    other_device = session_h(client, store, enroll(client, store), "cash")
    resp = _ask(client, counter, -500, h=other_device, approval=approval)
    assert resp.json()["detail"]["approval_error"] == "invalid"
    # A cashier on a bearer token can't use (or get) one either.
    resp = _ask(client, counter, -500, h=store["cashier"], approval=approval)
    assert resp.json()["detail"]["approval_error"] == "invalid"
    assert client.post("/v1/approvals", json={}, headers=store["cashier"]).status_code == 403
    assert _ask(client, counter, -500, approval=approval).status_code == 200


def test_failed_write_does_not_consume_the_approval(client, store, counter, admin_conn):
    needed = _ask(client, counter, -9000).json()["detail"]
    approval = _approve(client, store, counter, needed).json()["approval_id"]
    resp = _ask(client, counter, -9000, approval=approval)
    assert resp.status_code == 409  # balance is only 5000
    used = admin_conn.execute(
        "SELECT consumed_at FROM approval WHERE id = %s", (approval,)
    ).fetchone()["consumed_at"]
    assert used is None


def test_store_policy_limit_and_deny(client, store, counter, admin_conn):
    def policy(role, mode, limit=None):
        admin_conn.execute(
            "INSERT INTO approval_policy (tenant_id, role_id, perm, mode, limit_cents) "
            "SELECT %s, id, 'credit.adjust', %s, %s FROM role WHERE tenant_id IS NULL AND key = %s",
            (store["id"], mode, limit, role),
        )

    policy("cashier", "approval", 500)
    resp = _ask(client, counter, 300)
    assert resp.status_code == 200, resp.text
    approved = admin_conn.execute(
        "SELECT approved_by FROM credit_ledger WHERE customer_id = %s AND reason = 'fix'",
        (store["customer_id"],),
    ).fetchone()["approved_by"]
    assert approved is None
    assert _ask(client, counter, -500).status_code == 200  # at the limit
    assert _ask(client, counter, -501).json()["detail"]["approval_required"] == "credit.adjust"

    policy("manager", "deny")
    mh = session_h(client, store, counter["device"], "mgr")
    resp = _ask(client, counter, 100, h=mh)
    assert resp.status_code == 403 and resp.json() == {"detail": {"missing": "credit.adjust"}}
    # The owner (no row) still just has the permission.
    resp = client.post(
        counter["url"], json={"delta_cents": 100, "reason": "fix"}, headers=store["owner"]
    )
    assert resp.status_code == 200

    # Another store keeps the defaults.
    other = admin_conn.execute(
        "SELECT count(*) AS n FROM approval_policy WHERE tenant_id IS NULL"
    ).fetchone()["n"]
    assert other == 4


def test_owner_adjusts_directly(client, store, counter, admin_conn):
    resp = client.post(
        counter["url"], json={"delta_cents": -100, "reason": "fix"}, headers=store["owner"]
    )
    assert resp.status_code == 200 and resp.json()["balance_cents"] == 4900
    assert (
        client.post(
            counter["url"], json={"delta_cents": 0, "reason": "fix"}, headers=store["owner"]
        ).status_code
        == 422
    )


# --- tenancy and grants ------------------------------------------------------------


def test_app_role_cannot_read_secrets_or_other_stores(client, store, make_tenant):
    import psycopg

    from conftest import app_conn

    device = enroll(client, store)
    sign_in(client, store, device, "cash")
    for sql in (
        "SELECT secret_hash FROM register_device",
        "SELECT token_hash FROM register_session",
    ):
        with app_conn(store["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(sql)
    with app_conn(store["id"]) as conn:
        assert conn.execute("SELECT count(*) AS n FROM register_device").fetchone()["n"] == 1
        assert conn.execute("SELECT count(*) AS n FROM staff_pin").fetchone()["n"] == 3
    other = make_tenant()
    with app_conn(other["id"]) as conn:
        for table in ("register_device", "register_session", "staff_pin", "approval"):
            assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0, table
        # Only the system defaults are visible from another store.
        n = conn.execute("SELECT count(*) AS n FROM approval_policy").fetchone()["n"]
        assert n == 4


# --- what a register session can never do (security review P1) ----------------------


def test_an_owner_pin_on_a_register_is_not_an_admin(client, store, admin_conn):
    device = enroll(client, store)
    h = session_h(client, store, device, "boss")
    back_office_only = {"reason": "back_office_only"}
    resp = client.post("/v1/api-keys", json={"name": "x", "perms": ["inventory.read"]}, headers=h)
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"missing": "apikeys.manage", **back_office_only}
    reg = client.get("/v1/registers", headers=store["owner"]).json()[0]
    resp = client.post(f"/v1/registers/{reg['id']}/enroll", headers=h)
    assert resp.status_code == 403 and resp.json()["detail"]["missing"] == "registers.manage"
    resp = client.post(
        "/v1/invites", json={"email": "evil@attacker.test", "role": "owner"}, headers=h
    )
    assert resp.status_code == 403 and resp.json()["detail"]["missing"] == "staff.manage"
    resp = client.delete(f"/v1/staff/{store['uid']['mgr']}", headers=h)
    assert resp.status_code == 403
    rule = {"nm_bp": 10000, "lp_bp": 9000, "mp_bp": 7500, "hp_bp": 6000, "dmg_bp": 4000}
    rule.update(min_price_cents=25, round_up_to_cents=25)
    resp = client.put("/v1/pricing/rule", json=rule, headers=h)
    assert resp.status_code == 403 and resp.json()["detail"]["missing"] == "pricing.rules_manage"
    # Counter work still works, and the session reports what it can do.
    assert client.get("/v1/inventory", headers=h).status_code == 200
    perms = set(sign_in(client, store, device, "boss").json()["perms"])
    assert "pos.sell" in perms and "approve.override" in perms
    assert not perms & {"staff.manage", "apikeys.manage", "registers.manage", "billing.manage"}
    nothing = admin_conn.execute(
        "SELECT (SELECT count(*) FROM api_key WHERE tenant_id = %s) + "
        "(SELECT count(*) FROM invite WHERE tenant_id = %s) AS n",
        (store["id"], store["id"]),
    ).fetchone()["n"]
    assert nothing == 0


def test_an_approval_policy_cannot_give_a_register_an_admin_perm(client, store, admin_conn):
    admin_conn.execute(
        "INSERT INTO approval_policy (tenant_id, role_id, perm, mode) "
        "SELECT %s, id, 'staff.manage', 'allow' FROM role "
        "WHERE tenant_id IS NULL AND key = 'owner'",
        (store["id"],),
    )
    from fastapi import HTTPException

    from conftest import app_conn
    from tcg_pos_api.auth.approvals import require_or_approval
    from tcg_pos_api.auth.perms import Perm
    from tcg_pos_api.auth.principal import Principal, TenantSession

    check = require_or_approval(Perm.STAFF_MANAGE).dependency
    principal = Principal(
        user_id=store["uid"]["boss"],
        tenant_id=store["id"],
        role_key="owner",
        perms=frozenset(),
        location_ids=None,
        actor="device:x/user:y",
        kind="device",
    )
    with app_conn(store["id"]) as conn:
        with pytest.raises(HTTPException) as err:
            check(TenantSession(conn=conn, principal=principal), None, None)
    assert err.value.detail == {"missing": "staff.manage", "reason": "back_office_only"}


def test_an_api_key_row_holding_an_admin_perm_does_not_grant_it(client, store, admin_conn):
    resp = client.post(
        "/v1/api-keys", json={"name": "k", "perms": ["inventory.read"]}, headers=store["owner"]
    )
    key = resp.json()
    # Planted directly (the API refuses to create it).
    admin_conn.execute(
        "UPDATE api_key SET perms = perms || '{staff.manage,apikeys.manage}' WHERE id = %s",
        (key["id"],),
    )
    h = {"Authorization": f"ApiKey {key['key']}"}
    assert client.get("/v1/inventory", headers=h).status_code == 200
    resp = client.get("/v1/staff", headers=h)
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"missing": "staff.manage", "reason": "back_office_only"}


@pytest.mark.parametrize(
    "overrides",
    [
        {"amount_cents": 2**70},  # used to 500 after the PIN was verified
        {"amount_cents": 2**31},
        {"amount_cents": -1},
        {"amount_cents": "100"},
        {"perm": "x" * 65},
        {"payload_hash": "A" * 64},
    ],
    ids=["huge", "over-int32", "negative", "string", "long-perm", "bad-hash"],
)
def test_bad_approval_requests_are_refused_before_the_pin(client, store, admin_conn, overrides):
    device = enroll(client, store)
    ch = session_h(client, store, device, "cash")
    body = {
        "perm": "credit.adjust",
        "payload_hash": "a" * 64,
        "amount_cents": 100,
        "approver_user_id": str(store["uid"]["mgr"]),
        "pin": "999990",  # wrong: if it were checked it would count
        **overrides,
    }
    resp = client.post("/v1/approvals", json=body, headers=ch)
    assert resp.status_code == 422, resp.text
    assert _fails(admin_conn, store, store["uid"]["mgr"]) == 0


def test_approval_request_says_what_is_being_approved(client, store, counter):
    up = _ask(client, counter, 2500).json()["detail"]
    down = _ask(client, counter, -2500).json()["detail"]
    # Same perm and unsigned amount: only the summary tells them apart.
    assert (up["approval_required"], up["amount_cents"]) == ("credit.adjust", 2500)
    assert (down["approval_required"], down["amount_cents"]) == ("credit.adjust", 2500)
    assert up["summary"] == {
        "title": "Add $25.00 store credit",
        "lines": [
            "Customer: Pat",
            "Change: +$25.00 (add to their balance)",
            "Reason: fix",
            "Balance: $50.00 -> $75.00",
        ],
        "customer_name": "Pat",
        "delta_cents": 2500,
        "reason": "fix",
        "balance_cents": 5000,
    }
    assert down["summary"]["title"] == "Remove $25.00 store credit"
    assert down["summary"]["delta_cents"] == -2500
    assert down["summary"]["lines"][1] == "Change: -$25.00 (take from their balance)"
    # An approval_error 403 carries it too, and the flow still works.
    approval = _approve(client, store, counter, down).json()["approval_id"]
    bad = _ask(client, counter, -2499, approval=approval).json()["detail"]
    assert bad["approval_error"] == "invalid" and bad["summary"]["delta_cents"] == -2499
    assert _ask(client, counter, -2500, approval=approval).status_code == 200
    # No approval for a customer that doesn't exist.
    resp = client.post(
        f"/v1/customers/{uuid.uuid4()}/credit/adjust",
        json={"delta_cents": 100, "reason": "fix"},
        headers=counter["cashier"],
    )
    assert resp.status_code == 404


# --- sessions end when access changes (security review P4/P5) ------------------------


def _session_reason(client, h):
    resp = client.get("/v1/inventory", headers=h)
    return resp.status_code, resp.json().get("detail", {}).get("reason")


def test_disabling_ends_register_sessions_and_reenabling_does_not_revive_them(client, store):
    device = enroll(client, store)
    h = session_h(client, store, device, "cash")
    assert client.delete(f"/v1/staff/{store['uid']['cash']}", headers=store["owner"]).status_code
    assert _session_reason(client, h) == (401, "session_ended")
    resp = client.patch(
        f"/v1/staff/{store['uid']['cash']}", json={"status": "active"}, headers=store["owner"]
    )
    assert resp.status_code == 200
    assert _session_reason(client, h) == (401, "session_ended")
    # They can sign in again, with a new session.
    assert _session_reason(client, session_h(client, store, device, "cash"))[0] == 200


def test_a_role_change_ends_register_sessions(client, store, admin_conn):
    device = enroll(client, store)
    h = session_h(client, store, device, "mgr")
    other = session_h(client, store, device, "cash")
    resp = client.patch(
        f"/v1/staff/{store['uid']['mgr']}", json={"role": "cashier"}, headers=store["owner"]
    )
    assert resp.status_code == 200
    assert _session_reason(client, h) == (401, "session_ended")
    assert _session_reason(client, other)[0] == 200  # only that person's


def test_a_new_pin_ends_the_persons_register_sessions(client, store, admin_conn):
    first, second = enroll(client, store), enroll(client, store)
    h1 = session_h(client, store, first, "mgr")
    h2 = session_h(client, store, second, "mgr")
    other = session_h(client, store, first, "cash")
    resp = client.put("/v1/me/pin", json={"pin": "582039"}, headers=store["manager"])
    assert resp.status_code == 204
    assert _session_reason(client, h1) == (401, "session_ended")
    assert _session_reason(client, h2) == (401, "session_ended")
    assert _session_reason(client, other)[0] == 200
    audit = admin_conn.execute(
        "SELECT after FROM audit_log WHERE tenant_id = %s AND action = 'pin.set' "
        "AND entity_id = %s ORDER BY at DESC LIMIT 1",
        (store["id"], store["uid"]["mgr"]),
    ).fetchone()["after"]
    assert audit == {"pin": "set", "sessions_ended": 2}


# --- lockout per device, store-wide ceiling (security review P2) ----------------------


def _locks(admin_conn, store, user):
    return [
        r["after"]["scope"]
        for r in admin_conn.execute(
            "SELECT after FROM audit_log WHERE tenant_id = %s AND action = 'pin.lock' "
            "AND entity_id = %s ORDER BY at, id",
            (store["id"], user),
        )
    ]


def test_one_register_cannot_lock_a_pin_on_the_others(client, store, admin_conn):
    """Anyone at a register can type wrong PINs for the manager; that locks
    the manager out of that register only."""
    counter, office = enroll(client, store), enroll(client, store)
    for _ in range(6):
        resp = sign_in(client, store, counter, "mgr", pin="999990")
    assert resp.status_code == 423 and resp.json()["detail"]["scope"] == "device"
    assert sign_in(client, store, counter, "mgr").status_code == 423  # still locked there
    assert sign_in(client, store, office, "mgr").status_code == 201  # not here
    assert _locks(admin_conn, store, store["uid"]["mgr"]) == ["device"]  # 6th: not checked
    lock = admin_conn.execute(
        "SELECT actor, after FROM audit_log WHERE tenant_id = %s AND action = 'pin.lock' "
        "ORDER BY at, id LIMIT 1",
        (store["id"],),
    ).fetchone()
    assert lock["actor"] == f"device:{counter['device']['id']}"
    assert lock["after"]["seconds"] == 60 and lock["after"]["purpose"] == "sign_in"
    # The success on the other register reset the store-wide count, but the
    # register that was being guessed on stays locked.
    row = admin_conn.execute(
        "SELECT fail_count, fail_devices FROM staff_pin WHERE tenant_id = %s AND user_id = %s",
        (store["id"], store["uid"]["mgr"]),
    ).fetchone()
    assert row == {"fail_count": 0, "fail_devices": []}


def test_one_register_alone_never_trips_the_store_wide_lock(client, store, admin_conn):
    counter, office = enroll(client, store), enroll(client, store)
    mgr = store["uid"]["mgr"]
    for _ in range(15):  # far past the store-wide threshold, one lock period at a time
        _unlock_now(admin_conn, store, mgr)
        assert sign_in(client, store, counter, "mgr", pin="999990").status_code in (403, 423)
    row = admin_conn.execute(
        "SELECT fail_count, locked_until FROM staff_pin WHERE tenant_id = %s AND user_id = %s",
        (store["id"], mgr),
    ).fetchone()
    assert row == {"fail_count": 15, "locked_until": None}
    assert sign_in(client, store, office, "mgr").status_code == 201


def test_guessing_across_registers_hits_the_store_wide_ceiling(client, store, admin_conn):
    """Spreading guesses over registers can't beat the per-person budget:
    11 straight failures from two or more devices lock the PIN everywhere
    for an hour, and every further failure does again."""
    devices = [enroll(client, store) for _ in range(4)]
    mgr = store["uid"]["mgr"]
    codes = []
    for device, tries in zip(devices[:3], (5, 5, 1), strict=True):
        codes += [sign_in(client, store, device, "mgr", pin="999990") for _ in range(tries)]
    last = codes[-1]
    assert [r.status_code for r in codes[:4]] == [403] * 4
    assert last.status_code == 423
    assert last.json()["detail"] == {"reason": "pin_locked", "retry_after": 3600, "scope": "store"}
    # Locked on every register, including one never guessed on.
    resp = sign_in(client, store, devices[3], "mgr")
    assert resp.status_code == 423 and resp.json()["detail"]["scope"] == "store"
    assert _locks(admin_conn, store, mgr) == ["device", "device", "store"]
    # Past the ceiling, each further failure (on any device) locks for an hour again.
    _unlock_now(admin_conn, store, mgr)
    resp = sign_in(client, store, devices[3], "mgr", pin="999990")
    assert resp.status_code == 423 and resp.json()["detail"]["retry_after"] == 3600
    # A new PIN clears every lock.
    assert client.put("/v1/me/pin", json={"pin": "640273"}, headers=store["manager"]).status_code
    for device in devices:
        assert sign_in(client, store, device, "mgr", pin="640273").status_code == 201


def test_wrong_pin_attempts_left_counts_down_to_the_nearer_lock(client, store, admin_conn):
    a, b, c = enroll(client, store), enroll(client, store), enroll(client, store)
    for _ in range(4):
        sign_in(client, store, a, "mgr", pin="999990")
    for _ in range(4):
        sign_in(client, store, b, "mgr", pin="999990")
    resp = sign_in(client, store, c, "mgr", pin="999990")  # 9th store-wide, 1st here
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"reason": "wrong_pin", "attempts_left": 2}
