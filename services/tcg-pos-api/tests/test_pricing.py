"""Price rule, suggestions and setting prices, against a real Postgres and a
fake mtg-api. Skipped without TEST_DATABASE_URL."""

import uuid

import httpx

from conftest import adjust_body, headers, requires_db

pytestmark = requires_db

RULE = {
    "nm_bp": 10000,
    "lp_bp": 8500,
    "mp_bp": 7000,
    "hp_bp": 5000,
    "dmg_bp": 3000,
    "min_price_cents": 50,
    "round_up_to_cents": 10,
}


def _suggest(client, t, printing, finish="nonfoil", condition="NM", **extra):
    params = {"printing_id": str(printing), "finish": finish, "condition": condition, **extra}
    return client.get("/v1/pricing/suggest", params=params, headers=headers(t))


def test_rule_defaults_then_update_is_audited(client, make_tenant, admin_conn):
    t = make_tenant()
    got = client.get("/v1/pricing/rule", headers=headers(t)).json()
    assert got["is_default"] is True and got["lp_bp"] == 9000 and got["round_up_to_cents"] == 25

    resp = client.put("/v1/pricing/rule", json=RULE, headers=headers(t, actor="owner"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_default"] is False and resp.json()["lp_bp"] == 8500
    resp = client.put(
        "/v1/pricing/rule", json={**RULE, "lp_bp": 8000}, headers=headers(t, actor="owner")
    )
    assert resp.json()["lp_bp"] == 8000
    assert client.get("/v1/pricing/rule", headers=headers(t)).json()["lp_bp"] == 8000

    audit = admin_conn.execute(
        "SELECT actor, action, entity_id, before, after FROM audit_log "
        "WHERE tenant_id = %s AND entity = 'price_rule' ORDER BY at",
        (t["id"],),
    ).fetchall()
    assert [a["action"] for a in audit] == ["price_rule.update"] * 2
    assert audit[0]["before"] is None and audit[0]["after"]["lp_bp"] == 8500
    assert audit[1]["before"]["lp_bp"] == 8500 and audit[1]["after"]["lp_bp"] == 8000
    assert audit[0]["entity_id"] == t["id"]

    # Another tenant still sees the defaults.
    other = make_tenant("Other")
    assert client.get("/v1/pricing/rule", headers=headers(other)).json()["is_default"] is True


def test_rule_validation(client, make_tenant):
    t = make_tenant()
    for bad in ({"lp_bp": -1}, {"lp_bp": 100_001}, {"round_up_to_cents": 0},
                {"min_price_cents": 1.5}, {"nm_bp": "100"}):
        resp = client.put("/v1/pricing/rule", json={**RULE, **bad}, headers=headers(t))
        assert resp.status_code == 422, bad
    resp = client.put("/v1/pricing/rule", json=RULE, headers={"X-Tenant-Id": str(t["id"])})
    assert resp.status_code == 401


def test_suggest_uses_tcgplayer_reference_and_rule(client, make_tenant, fake_catalog):
    t = make_tenant()
    printing = uuid.uuid4()
    fake_catalog.prices[(str(printing), "foil")] = {
        "mtgjson_tcgplayer_retail_usd": 1410,
        "scryfall_usd_trend_usd": 1500,
        "cardmarket_guide_trend_eur": 1190,
    }
    body = _suggest(client, t, printing, finish="foil", condition="LP").json()
    # 1410 * 90% = 1269 -> up to the next 25c -> 1275
    assert body["suggested_cents"] == 1275
    assert body["reference_cents"] == 1410
    assert body["reference_source"] == "mtgjson_tcgplayer_retail_usd"
    assert body["multiplier_bp"] == 9000
    assert body["snapshot_id"] == "2026-10-09.1"
    assert body["stale"] is False and body["attribution"] == ["MTGJSON", "Scryfall"]
    assert body["sku_condition"] == "NM"

    client.put("/v1/pricing/rule", json=RULE, headers=headers(t))
    body = _suggest(client, t, printing, finish="foil", condition="LP").json()
    assert body["suggested_cents"] == 1200  # 1198.5 -> 1199 -> 1200


def test_suggest_falls_back_to_scryfall_and_nulls_without_usd(client, make_tenant, fake_catalog):
    t = make_tenant()
    scry_only, eur_only, missing = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    fake_catalog.prices[(str(scry_only), "nonfoil")] = {"scryfall_usd_trend_usd": 333}
    fake_catalog.prices[(str(eur_only), "nonfoil")] = {"cardmarket_guide_trend_eur": 500}

    body = _suggest(client, t, scry_only).json()
    assert (body["reference_source"], body["suggested_cents"]) == ("scryfall_usd_trend_usd", 350)

    for printing, note in ((eur_only, "no USD price"), (missing, "not found")):
        resp = _suggest(client, t, printing)
        assert resp.status_code == 200
        body = resp.json()
        assert body["suggested_cents"] is None  # unknown, not $0
        assert body["reference_cents"] is None and note in body["note"]


def test_suggest_validates_params_and_reports_catalog_outage(client, make_tenant, fake_catalog):
    t = make_tenant()
    assert _suggest(client, t, uuid.uuid4(), finish="galaxy").status_code == 422
    assert _suggest(client, t, uuid.uuid4(), condition="Mint").status_code == 422
    assert _suggest(client, t, "not-a-uuid").status_code == 422

    def down(request):
        raise httpx.ConnectError("refused")

    fake_catalog.handler = down
    resp = _suggest(client, t, uuid.uuid4())
    assert resp.status_code == 502 and "mtg-api" in resp.json()["detail"]


def test_patch_price_is_audited_and_leaves_ledger_alone(client, make_tenant, admin_conn):
    t = make_tenant()
    item = client.post("/v1/inventory/adjust", json=adjust_body(t), headers=headers(t)).json()
    item_id = item["item"]["id"]

    resp = client.patch(
        f"/v1/inventory/{item_id}", json={"price_cents": 1275}, headers=headers(t, actor="pat")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["price_cents"] == 1275 and resp.json()["qty"] == 4
    # Same price again: no-op, no extra audit row.
    client.patch(f"/v1/inventory/{item_id}", json={"price_cents": 1275}, headers=headers(t))
    # Clearing back to unknown.
    resp = client.patch(f"/v1/inventory/{item_id}", json={"price_cents": None}, headers=headers(t))
    assert resp.json()["price_cents"] is None

    audit = admin_conn.execute(
        "SELECT action, actor, before, after FROM audit_log WHERE entity_id = %s ORDER BY at",
        (item_id,),
    ).fetchall()
    assert [a["action"] for a in audit] == ["inventory.adjust"] + ["inventory.price"] * 2
    assert audit[1]["actor"] == "pat"
    assert audit[1]["before"]["price_cents"] is None and audit[1]["after"]["price_cents"] == 1275
    n_ledger = admin_conn.execute(
        "SELECT count(*) AS n FROM inventory_ledger WHERE inventory_item_id = %s", (item_id,)
    ).fetchone()["n"]
    assert n_ledger == 1


def test_patch_price_validation_and_isolation(client, make_tenant):
    a, b = make_tenant("A"), make_tenant("B")
    item_id = client.post(
        "/v1/inventory/adjust", json=adjust_body(a), headers=headers(a)
    ).json()["item"]["id"]
    for bad in ({"price_cents": -1}, {"price_cents": 12.5}, {"price_cents": "12.00"},
                {"price_cents": 2**31}, {}):
        resp = client.patch(f"/v1/inventory/{item_id}", json=bad, headers=headers(a))
        assert resp.status_code == 422, bad
    resp = client.patch(f"/v1/inventory/{item_id}", json={"price_cents": 1}, headers=headers(b))
    assert resp.status_code == 404
    resp = client.patch(
        f"/v1/inventory/{uuid.uuid4()}", json={"price_cents": 1}, headers=headers(a)
    )
    assert resp.status_code == 404


def test_adjust_can_set_price_when_receiving(client, make_tenant, admin_conn):
    t = make_tenant()
    printing = uuid.uuid4()
    resp = client.post(
        "/v1/inventory/adjust",
        json=adjust_body(t, printing_id=printing, delta=3, price_cents=1275),
        headers=headers(t),
    )
    assert resp.status_code == 200, resp.text
    item = resp.json()["item"]
    assert (item["qty"], item["price_cents"]) == (3, 1275)
    # Omitting price_cents leaves the price alone.
    item = client.post(
        "/v1/inventory/adjust", json=adjust_body(t, printing_id=printing, delta=-1),
        headers=headers(t),
    ).json()["item"]
    assert (item["qty"], item["price_cents"]) == (2, 1275)
    audit = admin_conn.execute(
        "SELECT after FROM audit_log WHERE entity_id = %s ORDER BY at", (item["id"],)
    ).fetchall()
    assert audit[0]["after"]["price_cents"] == 1275
