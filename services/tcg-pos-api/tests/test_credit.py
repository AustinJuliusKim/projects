"""Store-credit API against a real Postgres. Skipped without TEST_DATABASE_URL."""

import uuid
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest

from conftest import actor_of, app_conn, headers, requires_db

pytestmark = requires_db


def _url(t, action=None):
    base = f"/v1/customers/{t['customer_id']}/credit"
    return f"{base}/{action}" if action else base


def test_new_customer_balance_is_zero(client, make_tenant):
    t = make_tenant()
    assert client.get(_url(t), headers=headers(t)).json() == {
        "customer_id": str(t["customer_id"]),
        "balance_cents": 0,
    }


def test_unknown_customer_is_404(client, make_tenant):
    t = make_tenant()
    other = {**t, "customer_id": uuid.uuid4()}
    assert client.get(_url(other), headers=headers(t)).status_code == 404
    resp = client.post(
        _url(other, "issue"), json={"amount_cents": 100, "reason": "x"}, headers=headers(t)
    )
    assert resp.status_code == 404


def test_issue_then_redeem(client, make_tenant, admin_conn):
    t = make_tenant()
    resp = client.post(
        _url(t, "issue"), json={"amount_cents": 2500, "reason": "buylist"}, headers=headers(t)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["balance_cents"] == 2500
    resp = client.post(
        _url(t, "redeem"), json={"amount_cents": 999, "reason": "sale"}, headers=headers(t)
    )
    assert resp.json()["balance_cents"] == 1501
    assert client.get(_url(t), headers=headers(t)).json()["balance_cents"] == 1501

    ledger = admin_conn.execute(
        "SELECT delta_cents, reason, actor FROM credit_ledger WHERE customer_id = %s "
        "ORDER BY created_at",
        (t["customer_id"],),
    ).fetchall()
    assert [(r["delta_cents"], r["reason"], r["actor"]) for r in ledger] == [
        (2500, "buylist", actor_of("clerk@test")),
        (-999, "sale", actor_of("clerk@test")),
    ]
    audit = admin_conn.execute(
        "SELECT action, before, after FROM audit_log WHERE entity_id = %s ORDER BY at",
        (t["customer_id"],),
    ).fetchall()
    assert [a["action"] for a in audit] == ["credit.issue", "credit.redeem"]
    assert audit[1]["before"] == {"balance_cents": 2500}
    assert audit[1]["after"]["balance_cents"] == 1501


def test_redeem_cannot_go_negative(client, make_tenant, admin_conn):
    t = make_tenant()
    client.post(_url(t, "issue"), json={"amount_cents": 500, "reason": "x"}, headers=headers(t))
    resp = client.post(
        _url(t, "redeem"), json={"amount_cents": 501, "reason": "x"}, headers=headers(t)
    )
    assert resp.status_code == 409
    assert client.get(_url(t), headers=headers(t)).json()["balance_cents"] == 500
    n = admin_conn.execute(
        "SELECT count(*) AS n FROM credit_ledger WHERE customer_id = %s", (t["customer_id"],)
    ).fetchone()["n"]
    assert n == 1


def test_concurrent_redeems_never_overdraw(client, make_tenant):
    """Ten registers try to redeem $1 against a $3 balance at once: the
    customer row lock serializes them, so exactly three succeed."""
    t = make_tenant()
    client.post(_url(t, "issue"), json={"amount_cents": 300, "reason": "x"}, headers=headers(t))

    def redeem(_):
        return client.post(
            _url(t, "redeem"), json={"amount_cents": 100, "reason": "x"}, headers=headers(t)
        ).status_code

    with ThreadPoolExecutor(max_workers=10) as pool:
        codes = list(pool.map(redeem, range(10)))
    assert sorted(codes) == [200] * 3 + [409] * 7
    assert client.get(_url(t), headers=headers(t)).json()["balance_cents"] == 0


def test_credit_body_validation(client, make_tenant):
    t = make_tenant()
    for amount in (0, -5, 1.5, "12.00", 2**31):
        resp = client.post(
            _url(t, "issue"), json={"amount_cents": amount, "reason": "x"}, headers=headers(t)
        )
        assert resp.status_code == 422, amount


def test_credit_ledger_rejects_update_and_delete(client, make_tenant, admin_conn):
    t = make_tenant()
    client.post(_url(t, "issue"), json={"amount_cents": 100, "reason": "x"}, headers=headers(t))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        admin_conn.execute("UPDATE credit_ledger SET delta_cents = 1000000")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        admin_conn.execute("DELETE FROM credit_ledger")
    for stmt in ("UPDATE credit_ledger SET delta_cents = 1000000", "DELETE FROM credit_ledger"):
        with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(stmt)
    assert client.get(_url(t), headers=headers(t)).json()["balance_cents"] == 100


def test_credit_reason_is_bounded_and_nul_free(client, make_tenant):
    t = make_tenant()
    for reason in ("a\x00b", "x" * 501, " ", ""):
        resp = client.post(
            _url(t, "issue"), json={"amount_cents": 1, "reason": reason}, headers=headers(t)
        )
        assert resp.status_code == 422, reason
