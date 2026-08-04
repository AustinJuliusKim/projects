"""API tests: TestClient against a real Postgres seeded by the fixture
ingest. Skipped without TEST_DATABASE_URL (CI's service container sets it)."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set (start docker compose db)"
)

SERVICE_DIR = Path(__file__).resolve().parent.parent
FIXTURES = SERVICE_DIR / "tests" / "fixtures"


def load_jsonl(name):
    with open(FIXTURES / name, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


@pytest.fixture(scope="module")
def client():
    import psycopg
    from fastapi.testclient import TestClient

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

    from mtg_api.ingest.run import ingest_default, ingest_oracle, ingest_rulings

    with psycopg.connect(TEST_DATABASE_URL) as c:
        ingest_oracle(c, load_jsonl("oracle_sample.jsonl"))
        ingest_default(c, load_jsonl("default_sample.jsonl"))
        ingest_rulings(c, load_jsonl("rulings_sample.jsonl"))

    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
    from mtg_api.app import create_app

    with TestClient(create_app()) as tc:
        yield tc


def oracle_id_of(name):
    cards = load_jsonl("oracle_sample.jsonl")
    card = next(c for c in cards if c["name"] == name)
    return card.get("oracle_id") or card["card_faces"][0]["oracle_id"]


def test_healthz(client):
    assert client.get("/v1/healthz").json() == {"ok": True}


def test_root_carries_attribution(client):
    body = client.get("/").json()
    assert "Scryfall" in body["attribution"]


def test_card_by_id_with_representative_image(client):
    resp = client.get(f"/v1/cards/{oracle_id_of('Lightning Bolt')}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Lightning Bolt"
    assert body["mana_value"] == 1
    assert body["image_normal"]


def test_card_by_id_404_and_422(client):
    assert client.get("/v1/cards/00000000-0000-0000-0000-000000000000").status_code == 404
    assert client.get("/v1/cards/not-a-uuid").status_code == 422


def test_named_exact_case_insensitive(client):
    resp = client.get("/v1/cards/named", params={"exact": "lightning bolt"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Lightning Bolt"


def test_named_exact_multiface(client):
    resp = client.get("/v1/cards/named", params={"exact": "Fire // Ice"})
    assert resp.status_code == 200
    assert " // " in resp.json()["oracle_text"]


def test_named_fuzzy_misspelling(client):
    resp = client.get("/v1/cards/named", params={"fuzzy": "lightnig blot"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Lightning Bolt"


def test_named_requires_exactly_one_param(client):
    assert client.get("/v1/cards/named").status_code == 400
    assert (
        client.get("/v1/cards/named", params={"exact": "a", "fuzzy": "b"}).status_code == 400
    )
    assert client.get("/v1/cards/named", params={"exact": "zzz no such card"}).status_code == 404


def test_search_fts(client):
    body = client.get("/v1/cards/search", params={"q": "deals 3 damage"}).json()
    assert body["total"] >= 1
    assert any(c["name"] == "Lightning Bolt" for c in body["cards"])


def test_search_identity_filter(client):
    body = client.get("/v1/cards/search", params={"identity": "G"}).json()
    # Commander sense: mono-green and colorless fit within G.
    names = {c["name"] for c in body["cards"]}
    assert "Llanowar Elves" in names
    assert "Basalt Monolith" in names
    assert "Lightning Bolt" not in names


def test_search_type_and_mv_filters(client):
    body = client.get(
        "/v1/cards/search", params={"type": "instant", "mv_lte": 1, "order": "mv"}
    ).json()
    assert any(c["name"] == "Lightning Bolt" for c in body["cards"])
    assert all((c["mana_value"] or 0) <= 1 for c in body["cards"])


def test_search_pagination(client):
    page1 = client.get("/v1/cards/search", params={"page_size": 3, "page": 1}).json()
    page2 = client.get("/v1/cards/search", params={"page_size": 3, "page": 2}).json()
    assert len(page1["cards"]) == 3
    assert page1["total"] == page2["total"] > 3
    assert {c["oracle_id"] for c in page1["cards"]}.isdisjoint(
        c["oracle_id"] for c in page2["cards"]
    )


def test_search_page_size_cap(client):
    assert client.get("/v1/cards/search", params={"page_size": 101}).status_code == 422


def test_search_q_min_length(client):
    # A single leftover character (debounced live typing mid-backspace)
    # is rejected — the webapp itself is expected to skip firing this case
    # (see apps/mtg-webapp/src/App.jsx), this is the backend-side floor
    # matching /autocomplete's existing min_length=2.
    assert client.get("/v1/cards/search", params={"q": "a"}).status_code == 422


def test_search_omitted_q_is_still_unfiltered_browsing(client):
    # Omitting q entirely (not "too short") must stay legal — filter-only
    # searches (color/format/etc, no text) are a real, common case.
    assert client.get("/v1/cards/search").status_code == 200


def test_autocomplete(client):
    body = client.get("/v1/cards/autocomplete", params={"q": "light"}).json()
    assert "Lightning Bolt" in body["names"]
    assert len(body["names"]) <= 20


def test_random(client):
    assert client.get("/v1/cards/random").status_code == 200


def test_rulings(client):
    resp = client.get(f"/v1/cards/{oracle_id_of('Basalt Monolith')}/rulings")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1
    assert all("comment" in r for r in resp.json())


def test_printings_with_prices(client):
    resp = client.get(f"/v1/cards/{oracle_id_of('Lightning Bolt')}/printings")
    assert resp.status_code == 200
    printings = resp.json()
    assert len(printings) >= 3
    assert any(p["price_usd"] is not None for p in printings)
    assert all(p["set_code"] for p in printings)


def test_sets(client):
    sets = client.get("/v1/sets").json()
    assert len(sets) > 10
    one = client.get(f"/v1/sets/{sets[0]['code']}")
    assert one.status_code == 200
    assert client.get("/v1/sets/zzzz").status_code == 404


def test_docs_and_openapi_are_public(client):
    assert client.get("/docs").status_code == 200
    spec = client.get("/openapi.json").json()
    assert "/v1/cards/search" in spec["paths"]


def test_feedback_stores_events(client):
    events = [
        {
            "event": "impression",
            "seed_oracle_id": oracle_id_of("Sanguine Bond"),
            "suggested_oracle_id": oracle_id_of("Exquisite Blood"),
            "confidence": 0.8,
            "context": "card_page",
        },
        {
            "event": "click",
            "seed_oracle_id": oracle_id_of("Sanguine Bond"),
            "suggested_oracle_id": oracle_id_of("Exquisite Blood"),
        },
    ]
    resp = client.post("/v1/feedback/suggestions", json=events)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "stored": 2}


def test_feedback_drops_unknown_cards_silently(client):
    resp = client.post(
        "/v1/feedback/suggestions",
        json=[
            {
                "event": "impression",
                "seed_oracle_id": oracle_id_of("Sanguine Bond"),
                "suggested_oracle_id": "00000000-0000-0000-0000-000000000000",
            }
        ],
    )
    assert resp.status_code == 200
    assert resp.json()["stored"] == 0


def test_feedback_validates(client):
    assert client.post("/v1/feedback/suggestions", json=[]).status_code == 422
    bad = [{"event": "nope", "seed_oracle_id": "x", "suggested_oracle_id": "y"}]
    assert client.post("/v1/feedback/suggestions", json=bad).status_code == 422
