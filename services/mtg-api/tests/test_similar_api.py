"""/similar endpoint integration: real Postgres, fixture ingest, fake
embeddings via scripts/embed.py --fake. Skipped without TEST_DATABASE_URL."""

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


def run_script(script, *args, env_extra=None):
    return subprocess.run(
        [sys.executable, script, *args],
        cwd=SERVICE_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL, **(env_extra or {})},
        capture_output=True,
        text=True,
    )


@pytest.fixture(scope="module")
def client():
    import psycopg
    from fastapi.testclient import TestClient

    with psycopg.connect(TEST_DATABASE_URL) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        c.commit()
    assert run_script("scripts/migrate.py").returncode == 0

    from mtg_api.ingest.run import ingest_default, ingest_oracle

    with psycopg.connect(TEST_DATABASE_URL) as c:
        ingest_oracle(c, load_jsonl("oracle_sample.jsonl"))
        ingest_default(c, load_jsonl("default_sample.jsonl"))

    result = run_script("scripts/embed.py", "--fake")
    assert result.returncode == 0, result.stderr
    assert "20 stale card(s)" in result.stdout

    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
    from mtg_api.app import create_app

    with TestClient(create_app()) as tc:
        yield tc


def oracle_id_of(name):
    cards = load_jsonl("oracle_sample.jsonl")
    card = next(c for c in cards if c["name"] == name)
    return card.get("oracle_id") or card["card_faces"][0]["oracle_id"]


def test_embed_is_incremental(client):
    result = run_script("scripts/embed.py", "--fake")
    assert result.returncode == 0
    assert "0 stale card(s)" in result.stdout


def test_similar_shape(client):
    resp = client.get(f"/v1/cards/{oracle_id_of('Sanguine Bond')}/similar", params={"limit": 5})
    assert resp.status_code == 200
    results = resp.json()
    assert 1 <= len(results) <= 5
    for r in results:
        assert set(r) == {
            "oracle_id",
            "name",
            "type_line",
            "image_normal",
            "confidence",
            "band",
            "reasons",
        }
        assert 0 <= r["confidence"] <= 1
        assert r["band"] in {"high", "medium", "low"}
        assert r["name"] != "Sanguine Bond"


def test_similar_related_pair_outranks_unrelated(client):
    # Fake vectors are noise, so cosine is ~equal for all candidates — the
    # structured mechanic overlap must still rank the lifegain/lifeloss twin
    # (Exquisite Blood) above a mechanically unrelated card.
    resp = client.get(
        f"/v1/cards/{oracle_id_of('Sanguine Bond')}/similar", params={"limit": 50}
    )
    names = [r["name"] for r in resp.json()]
    assert "Exquisite Blood" in names
    assert names.index("Exquisite Blood") < names.index("Basalt Monolith")


def test_similar_identity_filter(client):
    resp = client.get(
        f"/v1/cards/{oracle_id_of('Llanowar Elves')}/similar", params={"identity": "G"}
    )
    assert resp.status_code == 200
    for r in resp.json():
        detail = client.get(f"/v1/cards/{r['oracle_id']}").json()
        assert set(detail["color_identity"] or []) <= {"G"}


def test_similar_format_filter(client):
    resp = client.get(
        f"/v1/cards/{oracle_id_of('Sanguine Bond')}/similar", params={"format": "commander"}
    )
    assert resp.status_code == 200
    for r in resp.json():
        detail = client.get(f"/v1/cards/{r['oracle_id']}").json()
        assert detail["legalities"]["commander"] == "legal"


def test_similar_min_confidence(client):
    all_results = client.get(f"/v1/cards/{oracle_id_of('Sanguine Bond')}/similar").json()
    top = max(r["confidence"] for r in all_results)
    filtered = client.get(
        f"/v1/cards/{oracle_id_of('Sanguine Bond')}/similar",
        params={"min_confidence": top},
    ).json()
    assert all(r["confidence"] >= top for r in filtered)
    assert len(filtered) <= len(all_results)


def test_similar_404s(client):
    assert client.get("/v1/cards/00000000-0000-0000-0000-000000000000/similar").status_code == 404


def test_similar_404_when_no_embedding(client):
    import psycopg

    with psycopg.connect(TEST_DATABASE_URL) as c:
        oid = oracle_id_of("Walking Ballista")
        c.execute("DELETE FROM card_embeddings WHERE oracle_id = %s", (oid,))
        c.commit()
    resp = client.get(f"/v1/cards/{oid}/similar")
    assert resp.status_code == 404
    assert "embedding" in resp.json()["detail"]
