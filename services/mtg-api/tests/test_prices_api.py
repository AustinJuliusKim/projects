"""/v1/prices end to end over 31 days of fixture snapshots (design §9):
every endpoint, nulls, a 200-item batch, ETag 304, stale at 36h late,
pinned history byte-identical after a correction, and the licensed /
qa-only lanes absent from every public response."""

import json
import os
import subprocess
import sys
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from starlette.requests import Request

from mtg_api.ratelimit import identify
from prices_fixtures import BLOOD, BLOOD_UUID, BOLT, FIXTURE_DAY, build_history, snapshot_day

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parent.parent
LAST_DAY = FIXTURE_DAY
FORBIDDEN = ("justtcg", "tcgcsv", "licensed", "qa-only", "JustTCG", "TCGCSV")

needs_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set")


def test_prices_paths_get_their_own_rate_limit_bucket():
    def req(path):
        return Request({"type": "http", "path": path, "headers": [], "client": ("1.2.3.4", 1)})

    assert identify(None, req("/v1/prices/mtg/1")) == ("ip:1.2.3.4:prices", 60)
    assert identify(None, req("/v1/sets"))[0] == "ip:1.2.3.4"
    assert identify(None, req("/v1/cards/search"))[0] == "ip:1.2.3.4:search"


def load_jsonl(name):
    text = (SERVICE_DIR / "tests" / "fixtures" / name).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


@pytest.fixture(scope="module")
def db():
    import psycopg

    from mtg_api.ingest.run import ingest_default, ingest_oracle

    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        c.commit()
    result = subprocess.run(
        [sys.executable, "scripts/migrate.py"],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    with psycopg.connect(TEST_DATABASE_URL) as c:
        ingest_oracle(c, load_jsonl("oracle_sample.jsonl"))
        ingest_default(c, load_jsonl("default_sample.jsonl"))
        build_history(c, LAST_DAY, days=31)
        _plant_private_lanes(c)
        c.commit()
        yield c


def _plant_private_lanes(conn):
    """Licensed and qa-only rows that must never surface."""
    seq = conn.execute("SELECT max(seq) AS s FROM price_snapshots").fetchone()[0]
    sku = sku_id(conn, BLOOD, "nonfoil")
    for code in ("justtcg", "tcgcsv"):
        src = conn.execute("SELECT id FROM price_sources WHERE code = %s", (code,)).fetchone()
        conn.execute(
            "INSERT INTO price_daily (sku_id, as_of, source_id, snapshot_seq, retail_cents) "
            "VALUES (%s, %s, %s, %s, 4242)",
            (sku, LAST_DAY, src[0], seq),
        )
        conn.execute(
            "INSERT INTO price_current (sku_id, source_id, snapshot_seq, as_of, retail_cents, "
            "change_7d) VALUES (%s, %s, %s, %s, 4242, 0.9)",
            (sku, src[0], seq, LAST_DAY),
        )
        conn.execute(
            "INSERT INTO price_movers (snapshot_seq, window_days, direction, rank, sku_id, "
            "source_id, price_cents, change) VALUES (%s, 7, 'up', %s, %s, %s, 4242, 0.9)",
            (seq, 90 + src[0], sku, src[0]),
        )


def sku_id(conn, printing_id, finish):
    return conn.execute(
        "SELECT id FROM skus WHERE printing_id = %s AND finish = %s", (printing_id, finish)
    ).fetchone()[0]


@pytest.fixture(scope="module")
def client(db):
    from fastapi.testclient import TestClient

    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
    from mtg_api.app import create_app

    with TestClient(create_app()) as tc:
        yield tc


def assert_public(resp):
    for word in FORBIDDEN:
        assert word not in resp.text, f"{word!r} leaked into {resp.request.url}"


@needs_db
def test_price_object_shape_and_provenance(client, db):
    resp = client.get(f"/v1/prices/mtg/{sku_id(db, BLOOD, 'nonfoil')}")
    assert resp.status_code == 200
    assert resp.headers["X-Price-Snapshot"] == "2026-10-08.1"
    assert "max-age=" in resp.headers["Cache-Control"]
    body = resp.json()
    assert body["own"] is None
    # 36.68 * 1.01^30, rounded each day from the base.
    expected = int((Decimal("36.68") * Decimal("1.01") ** 30).quantize(Decimal("0.01")) * 100)
    assert body["open"]["mtgjson_tcgplayer_retail_usd"] == expected
    assert isinstance(body["open"]["cardmarket_guide_trend_eur"], int)
    assert body["change"]["7d"] > 0.07 and body["change"]["30d"] > 0.34
    assert body["stale"] is False
    assert set(body["attribution"]) == {"MTGJSON", "Cardmarket", "Scryfall"}
    assert {p["source"] for p in body["provenance"]} >= {"mtgjson_tcgplayer", "cardmarket_guide"}
    assert_public(resp)


@needs_db
def test_sku_without_prices_is_nulls_not_zeros(client, db):
    new_id = db.execute(
        "INSERT INTO skus (printing_id, finish, lang) VALUES (%s, 'etched', 'en') RETURNING id",
        (BOLT,),
    ).fetchone()[0]
    db.commit()
    body = client.get(f"/v1/prices/mtg/{new_id}").json()
    assert body["open"] == {} and body["provenance"] == []
    assert body["change"] == {"1d": None, "7d": None, "30d": None}
    assert client.get("/v1/prices/mtg/999999999").status_code == 404
    assert client.get("/v1/prices/pokemon/1").status_code == 404


@needs_db
def test_etag_round_trip_gives_304(client, db):
    url = f"/v1/prices/mtg/{sku_id(db, BOLT, 'nonfoil')}"
    first = client.get(url)
    again = client.get(url, headers={"If-None-Match": first.headers["ETag"]})
    assert again.status_code == 304 and again.content == b""
    assert again.headers["X-Price-Snapshot"] == first.headers["X-Price-Snapshot"]
    assert client.get(url, headers={"If-None-Match": '"nope"'}).status_code == 200


@needs_db
def test_batch_of_200_with_external_ids(client, db):
    items = [
        {"sku_id": sku_id(db, BLOOD, "nonfoil")},
        {"tcgplayer_id": 697344},  # Lightning Bolt: nonfoil + foil SKUs
        {"scryfall_id": BOLT, "finish": "foil"},
        {"set": "M11", "number": "999"},  # unknown
        {"game": "pokemon", "sku_id": 1},
    ]
    items += [{"sku_id": sku_id(db, BOLT, "nonfoil")}] * (200 - len(items))
    resp = client.post("/v1/prices/batch", json={"items": items})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 200
    assert len(results[0]["prices"]) == 1
    assert {p["finish"] for p in results[1]["prices"]} == {"nonfoil", "foil"}
    assert [p["finish"] for p in results[2]["prices"]] == ["foil"]
    assert results[3] == {**results[3], "prices": [], "error": "not found"}
    assert results[4]["error"] == "unknown game"
    assert_public(resp)
    too_many = client.post("/v1/prices/batch", json={"items": items + [items[0]]})
    assert too_many.status_code == 422


@needs_db
def test_history_pinned_snapshot_is_byte_identical_after_a_correction(client, db):
    sku = sku_id(db, BLOOD, "nonfoil")
    pinned_url = f"/v1/prices/mtg/{sku}/history?snapshot=2026-10-08.1"
    before = client.get(pinned_url)
    assert before.status_code == 200
    assert "immutable" in before.headers["Cache-Control"]
    tcg = next(s for s in before.json()["series"] if s["source"] == "mtgjson_tcgplayer")
    assert len(tcg["points"]) == 30  # default window: 30 days ending at the snapshot

    snapshot_day(db, LAST_DAY, scale={BLOOD_UUID: Decimal("2")}, changelog="test correction")
    db.commit()
    after = client.get(pinned_url)
    assert after.content == before.content

    latest = client.get(f"/v1/prices/mtg/{sku}/history?series=retail")
    assert latest.headers["X-Price-Snapshot"] == "2026-10-08.2"
    tcg_latest = next(s for s in latest.json()["series"] if s["source"] == "mtgjson_tcgplayer")
    assert tcg_latest["points"][-1]["values"] == {"retail": 7336}
    assert_public(latest)


@needs_db
def test_history_validation_and_paging(client, db):
    sku = sku_id(db, BLOOD, "nonfoil")
    assert client.get(f"/v1/prices/mtg/{sku}/history?series=bogus").status_code == 422
    start = LAST_DAY - timedelta(days=400)
    body = client.get(f"/v1/prices/mtg/{sku}/history?from={start}").json()
    assert body["next_from"] == str(start + timedelta(days=366))
    assert body["to_date"] == str(start + timedelta(days=365))


@needs_db
def test_movers_are_stored_per_snapshot_and_filterable(client, db):
    resp = client.get("/v1/prices/mtg/movers?window=7d&snapshot=2026-10-08.1")
    assert resp.status_code == 200
    movers = resp.json()["movers"]
    assert [m["name"] for m in movers] == ["Exquisite Blood"]
    assert movers[0]["rank"] == 1 and movers[0]["change"] > 0.07
    # 1% a day never clears the 2% floor for the 1-day window.
    assert (
        client.get("/v1/prices/mtg/movers?window=1d&snapshot=2026-10-08.1").json()["movers"] == []
    )
    big = client.get("/v1/prices/mtg/movers?window=7d&min_price=1000000").json()
    assert big["movers"] == []
    assert_public(client.get("/v1/prices/mtg/movers?window=7d"))


@needs_db
def test_set_endpoint_and_snapshots(client, db):
    set_code = db.execute("SELECT set_code FROM printings WHERE id = %s", (BLOOD,)).fetchone()
    resp = client.get(f"/v1/prices/mtg/sets/{set_code[0].upper()}")
    assert resp.status_code == 200
    assert BLOOD in {p["printing_id"] for p in resp.json()["prices"]}
    assert_public(resp)
    assert client.get("/v1/prices/mtg/sets/zzz").status_code == 404

    listing = client.get("/v1/prices/snapshots?limit=3").json()
    assert [s["snapshot_id"] for s in listing][:2] == ["2026-10-08.2", "2026-10-08.1"]
    detail = client.get("/v1/prices/snapshots/2026-10-08.2")
    assert detail.json()["changelog"] == "test correction"
    assert detail.json()["fx_eur_usd"] == 1.0921
    assert client.get("/v1/prices/snapshots/1999-01-01.1").status_code == 404


@needs_db
def test_status_marks_a_source_stale_after_36_hours(client, db):
    fresh = client.get("/v1/prices/status").json()
    assert {s["source"] for s in fresh["sources"]} >= {"mtgjson_tcgplayer", "scryfall_usd"}
    assert not any(s["stale"] for s in fresh["sources"] if s["feed"] != "own")

    db.execute(
        "UPDATE ingest_runs SET bulk_updated_at = now() - interval '37 hours' "
        "WHERE source = 'prices:cardmarket_guide'"
    )
    db.commit()
    status = client.get("/v1/prices/status")
    assert_public(status)
    cm = next(s for s in status.json()["sources"] if s["source"] == "cardmarket_guide")
    assert cm["stale"] is True and cm["lag_hours"] >= 37
    body = client.get(f"/v1/prices/mtg/{sku_id(db, BLOOD, 'nonfoil')}").json()
    assert body["stale"] is True
    prov = {p["source"]: p["stale"] for p in body["provenance"]}
    assert prov["cardmarket_guide"] is True and prov["mtgjson_tcgplayer"] is False
