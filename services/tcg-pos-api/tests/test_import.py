"""TCGplayer CSV import against a real Postgres and a fake mtg-api.
Skipped without TEST_DATABASE_URL."""

import uuid
from pathlib import Path

import httpx
import pytest

from conftest import headers, requires_db

pytestmark = requires_db

FIXTURE = (Path(__file__).parent / "fixtures" / "tcgplayer_inventory.csv").read_bytes()
BOLT = uuid.uuid4()
SOL_RING = uuid.uuid4()


@pytest.fixture
def catalog(fake_catalog):
    fake_catalog.sets = [
        {"code": "m11", "name": "Magic 2011"},
        {"code": "cmr", "name": "Commander Legends"},
        {"code": "dup1", "name": "Duplicated"},
        {"code": "dup2", "name": "Duplicated"},
    ]
    fake_catalog.printings = {("m11", "149"): BOLT, ("cmr", "472"): SOL_RING}
    usd = {"mtgjson_tcgplayer_retail_usd": 100}
    for key in ((BOLT, "nonfoil"), (BOLT, "foil"), (SOL_RING, "etched")):
        fake_catalog.prices[(str(key[0]), key[1])] = usd
    return fake_catalog


def _import(client, t, data=FIXTURE, dry_run=True, location_id=None, **kw):
    return client.post(
        "/v1/inventory/import/tcgplayer",
        params={"location_id": str(location_id or t["location_id"]),
                "dry_run": str(dry_run).lower()},
        content=data,
        headers={**headers(t, **kw), "Content-Type": "text/csv"},
    )


def _grains(admin_conn, t):
    rows = admin_conn.execute(
        "SELECT printing_id, condition, finish, lang, qty, price_cents FROM inventory_item "
        "WHERE tenant_id = %s ORDER BY condition, finish, lang",
        (t["id"],),
    ).fetchall()
    return {(r["printing_id"], r["condition"], r["finish"], r["lang"]):
            (r["qty"], r["price_cents"]) for r in rows}


def test_dry_run_reports_rows_and_writes_nothing(client, make_tenant, catalog, admin_conn):
    t = make_tenant()
    resp = _import(client, t)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["dry_run"] is True and body["snapshot_id"] == "2026-10-09.1"
    assert body["totals"] == {
        "rows": 9, "matched": 5, "unmatched": 3, "skipped": 1,
        "grains": 4, "changed": 4, "qty_delta": 9,
    }
    by_row = {r["row"]: r for r in body["rows"]}
    assert by_row[2]["status"] == "matched" and by_row[2]["printing_id"] == str(BOLT)
    assert by_row[2]["set_code"] == "m11"
    assert by_row[5]["status"] == "skipped"
    assert "no set named 'Not A Real Set'" in by_row[6]["reason"]
    assert "no nonfoil printing for m11 #999" in by_row[7]["reason"]
    assert "condition" in by_row[8]["reason"]
    nm = next(c for c in body["changes"] if c["rows"] == [2, 9])  # same grain, summed
    assert (nm["current_qty"], nm["target_qty"], nm["delta"], nm["price_cents"]) == (0, 5, 5, 149)
    ja = next(c for c in body["changes"] if c["lang"] == "ja")
    assert (ja["finish"], ja["target_qty"], ja["price_cents"]) == ("foil", 1, None)
    assert _grains(admin_conn, t) == {}
    # Batched: one sets call and one batch call for the whole file.
    assert catalog.calls == [("GET", "/v1/sets"), ("POST", "/v1/prices/batch")]


def test_apply_sets_quantities_and_is_idempotent(client, make_tenant, catalog, admin_conn):
    t = make_tenant()
    resp = _import(client, t, dry_run=False, actor="importer")
    assert resp.status_code == 200, resp.text
    assert resp.json()["totals"]["qty_delta"] == 9
    expected = {
        (BOLT, "LP", "foil", "en"): (1, 499),
        (BOLT, "NM", "foil", "ja"): (1, None),
        (SOL_RING, "NM", "etched", "en"): (2, 101250),
        (BOLT, "NM", "nonfoil", "en"): (5, 149),
    }
    assert _grains(admin_conn, t) == expected
    ledger = admin_conn.execute(
        "SELECT delta, reason, channel, actor FROM inventory_ledger WHERE tenant_id = %s",
        (t["id"],),
    ).fetchall()
    assert sorted(r["delta"] for r in ledger) == [1, 1, 2, 5]
    assert {(r["reason"], r["channel"], r["actor"]) for r in ledger} == {
        ("tcgplayer import", "tcgplayer", "importer")
    }
    n_audit = admin_conn.execute(
        "SELECT count(*) AS n FROM audit_log WHERE tenant_id = %s AND action = 'inventory.import'",
        (t["id"],),
    ).fetchone()["n"]
    assert n_audit == 4

    # Re-applying the same file changes nothing (set, not add).
    again = _import(client, t, dry_run=False).json()
    assert again["totals"]["changed"] == 0 and again["totals"]["qty_delta"] == 0
    assert _grains(admin_conn, t) == expected
    n_ledger = admin_conn.execute(
        "SELECT count(*) AS n FROM inventory_ledger WHERE tenant_id = %s", (t["id"],)
    ).fetchone()["n"]
    assert n_ledger == 4


def test_apply_moves_existing_stock_to_csv_quantity(client, make_tenant, catalog, admin_conn):
    t = make_tenant()
    _import(client, t, dry_run=False)
    smaller = FIXTURE.replace(b"Near Mint,1.41,,,1.10,3,0,1.49", b"Near Mint,1.41,,,1.10,0,0,1.49")
    body = _import(client, t, data=smaller).json()
    nm = next(c for c in body["changes"] if c["rows"] == [2, 9])
    assert (nm["current_qty"], nm["target_qty"], nm["delta"]) == (5, 2, -3)
    _import(client, t, data=smaller, dry_run=False)
    assert _grains(admin_conn, t)[(BOLT, "NM", "nonfoil", "en")] == (2, 149)


def test_import_errors(client, make_tenant, catalog):
    t = make_tenant()
    assert _import(client, t, data=b"Set Name\nx\n").status_code == 422
    assert _import(client, t, location_id=uuid.uuid4()).status_code == 404
    other = make_tenant("Other")
    assert _import(client, t, location_id=other["location_id"]).status_code == 404
    resp = client.post(
        "/v1/inventory/import/tcgplayer",
        params={"location_id": str(t["location_id"])},
        content=FIXTURE,
        headers={"X-Tenant-Id": str(t["id"]), "Content-Type": "text/csv"},
    )
    assert resp.status_code == 401  # X-Actor required, even for a dry run

    def down(request):
        raise httpx.ConnectError("refused")

    catalog.handler = down
    resp = _import(client, t)
    assert resp.status_code == 502 and "mtg-api" in resp.json()["detail"]


def test_import_too_large_is_413(client, make_tenant, catalog, monkeypatch):
    from tcg_pos_api import tcgplayer

    t = make_tenant()
    monkeypatch.setattr(tcgplayer, "MAX_BYTES", 100)
    assert _import(client, t).status_code == 413
