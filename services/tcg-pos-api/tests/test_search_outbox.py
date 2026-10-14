"""0007_search_outbox: every inventory/storefront write enqueues an event in
the same transaction, the app role can enqueue but never read, and
claim/ack hand out disjoint rows. Web-order paths are covered in
test_web_orders.py. Skipped without TEST_DATABASE_URL."""

import contextlib
import uuid

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import TEST_DATABASE_URL, adjust_body, app_conn, headers, requires_db

pytestmark = requires_db


def outbox(admin_conn, tenant):
    return admin_conn.execute(
        "SELECT printing_id FROM search_outbox WHERE tenant_id = %s ORDER BY id", (tenant["id"],)
    ).fetchall()


@contextlib.contextmanager
def worker_conn():
    """A transaction as the M5 consumer runs: role tcg_pos_worker. Rolled
    back unless the test commits."""
    with psycopg.connect(TEST_DATABASE_URL, row_factory=dict_row) as conn:
        conn.execute("SET LOCAL ROLE tcg_pos_worker")
        try:
            yield conn
        finally:
            conn.rollback()


def test_app_role_can_enqueue_but_not_read_or_drain(make_tenant):
    t = make_tenant()
    with app_conn(t["id"]) as conn:
        conn.execute("INSERT INTO search_outbox (printing_id) VALUES (gen_random_uuid())")
    for stmt in (
        "SELECT * FROM search_outbox",
        "UPDATE search_outbox SET printing_id = NULL",
        "DELETE FROM search_outbox",
        "SELECT * FROM claim_search_outbox(10)",
        "SELECT ack_search_outbox(ARRAY[1]::bigint[])",
    ):
        with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(stmt)
    # Can't enqueue for another tenant, or with no tenant at all.
    other = make_tenant()
    with app_conn(t["id"]) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("INSERT INTO search_outbox (tenant_id) VALUES (%s)", (other["id"],))
    with app_conn(None) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("INSERT INTO search_outbox (printing_id) VALUES (NULL)")


def test_adjust_and_price_patch_enqueue(client, make_tenant, admin_conn):
    t = make_tenant()
    printing = uuid.uuid4()
    item = client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing), headers=headers(t)
    ).json()["item"]
    # lock_or_create_item inserts at qty 0 (no event), then sets qty (one event).
    assert [r["printing_id"] for r in outbox(admin_conn, t)] == [printing]

    resp = client.patch(
        f"/v1/inventory/{item['id']}", json={"price_cents": 199}, headers=headers(t)
    )
    assert resp.status_code == 200
    assert len(outbox(admin_conn, t)) == 2
    # Same price again: the route doesn't write, so nothing is enqueued.
    client.patch(f"/v1/inventory/{item['id']}", json={"price_cents": 199}, headers=headers(t))
    assert len(outbox(admin_conn, t)) == 2


def test_rejected_write_leaves_no_event(client, make_tenant, admin_conn):
    t = make_tenant()
    printing = uuid.uuid4()
    client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing, delta=1),
        headers=headers(t),
    )
    resp = client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing, delta=-5),
        headers=headers(t),
    )
    assert resp.status_code == 409
    assert len(outbox(admin_conn, t)) == 1


def test_event_is_in_the_same_transaction(make_tenant, admin_conn):
    t = make_tenant()
    item = admin_conn.execute(
        "INSERT INTO inventory_item (tenant_id, location_id, printing_id, condition, finish, qty) "
        "VALUES (%s, %s, gen_random_uuid(), 'NM', 'foil', 0) RETURNING id",
        (t["id"], t["location_id"]),
    ).fetchone()["id"]
    assert outbox(admin_conn, t) == []
    with app_conn(t["id"]) as conn:
        conn.execute("UPDATE inventory_item SET qty = 3 WHERE id = %s", (item,))
        # Visible to nobody else until commit; app_conn always rolls back.
        assert outbox(admin_conn, t) == []
    assert outbox(admin_conn, t) == []

    # A no-op update (same values) doesn't enqueue; a real one does.
    admin_conn.execute("UPDATE inventory_item SET qty = qty, updated_at = now() WHERE id = %s",
                       (item,))
    assert outbox(admin_conn, t) == []
    admin_conn.execute("UPDATE inventory_item SET location_id = location_id, qty = 1 "
                       "WHERE id = %s", (item,))
    assert len(outbox(admin_conn, t)) == 1


def test_notify_fires_on_commit(make_tenant, admin_conn):
    t = make_tenant()
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as listener:
        listener.execute("LISTEN search_outbox")
        admin_conn.execute(
            "INSERT INTO inventory_item (tenant_id, location_id, printing_id, condition, finish, "
            "qty) VALUES (%s, %s, gen_random_uuid(), 'NM', 'foil', 2)",
            (t["id"], t["location_id"]),
        )
        got = list(listener.notifies(timeout=5, stop_after=1))
    assert [n.channel for n in got] == ["search_outbox"]


def test_csv_import_apply_enqueues(client, make_tenant, fake_catalog, admin_conn):
    t = make_tenant()
    bolt = uuid.uuid4()
    fake_catalog.sets = [{"code": "m11", "name": "Magic 2011"}]
    fake_catalog.printings = {("m11", "149"): bolt}
    fake_catalog.prices[(str(bolt), "nonfoil")] = {"mtgjson_tcgplayer_retail_usd": 100}
    csv = (
        b"TCGplayer Id,Product Line,Set Name,Product Name,Number,Condition,Total Quantity,"
        b"TCG Marketplace Price\n"
        b"1,Magic,Magic 2011,Lightning Bolt,149,Near Mint,3,1.49\n"
    )

    def run(dry_run):
        return client.post(
            "/v1/inventory/import/tcgplayer",
            params={"location_id": str(t["location_id"]), "dry_run": dry_run},
            content=csv,
            headers={**headers(t), "Content-Type": "text/csv"},
        )

    assert run("true").status_code == 200
    assert outbox(admin_conn, t) == []  # dry run writes nothing
    assert run("false").status_code == 200, run
    rows = outbox(admin_conn, t)
    assert rows and {r["printing_id"] for r in rows} == {bolt}
    before = len(rows)
    assert run("false").status_code == 200  # re-apply is a no-op...
    assert len(outbox(admin_conn, t)) == before  # ...so no new event


def test_storefront_changes_enqueue_whole_tenant_events(client, make_tenant, admin_conn):
    t = make_tenant()
    body = {
        "slug": f"evt-{uuid.uuid4().hex[:10]}",
        "display_name": "Events",
        "published": False,
        "location_id": str(t["location_id"]),
    }
    assert client.put("/v1/storefront-settings", json=body, headers=headers(t)).status_code == 200
    assert [r["printing_id"] for r in outbox(admin_conn, t)] == [None]
    # Display-only change: no event.
    client.put(
        "/v1/storefront-settings", json={**body, "display_name": "Renamed"}, headers=headers(t)
    )
    assert len(outbox(admin_conn, t)) == 1
    for change in ({"published": True}, {"holdback_copies": 1}, {"holdback_pct": 5}):
        body = {**body, **change}
        client.put("/v1/storefront-settings", json=body, headers=headers(t))
    assert [r["printing_id"] for r in outbox(admin_conn, t)] == [None] * 4


def test_claim_skips_locked_rows_and_ack_deletes(make_tenant, admin_conn):
    t = make_tenant()
    admin_conn.execute("DELETE FROM search_outbox")
    admin_conn.execute(
        "INSERT INTO search_outbox (tenant_id, printing_id) "
        "SELECT %s, gen_random_uuid() FROM generate_series(1, 5)",
        (t["id"],),
    )
    with worker_conn() as first, worker_conn() as second:
        a = first.execute("SELECT * FROM claim_search_outbox(3)").fetchall()
        b = second.execute("SELECT * FROM claim_search_outbox(100)").fetchall()
        ids_a, ids_b = [r["id"] for r in a], [r["id"] for r in b]
        assert len(ids_a) == 3 and len(ids_b) == 2
        assert not set(ids_a) & set(ids_b)
        assert ids_a == sorted(ids_a) and max(ids_a) < min(ids_b)  # oldest first
        assert {r["tenant_id"] for r in a + b} == {t["id"]}
        n = first.execute("SELECT ack_search_outbox(%s) AS n", (ids_a,)).fetchone()["n"]
        assert n == 3
        first.commit()
        # `second` rolls back (a failed bulk request): its rows go back in the queue.
    left = admin_conn.execute("SELECT id FROM search_outbox ORDER BY id").fetchall()
    assert [r["id"] for r in left] == ids_b
    with worker_conn() as again:
        assert [r["id"] for r in again.execute(
            "SELECT id FROM claim_search_outbox(0)"
        )] == ids_b[:1]  # max_rows is clamped to at least 1
        assert again.execute("SELECT ack_search_outbox('{}') AS n").fetchone()["n"] == 0
