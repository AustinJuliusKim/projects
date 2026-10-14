"""Tenant/actor header handling and request validation — rejected before any
DB connection is opened, so these run without TEST_DATABASE_URL."""

import uuid

import pytest
from fastapi.testclient import TestClient

from tcg_pos_api.app import create_app


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as tc:
        yield tc


def _adjust(**overrides):
    body = {
        "location_id": str(uuid.uuid4()),
        "printing_id": str(uuid.uuid4()),
        "condition": "NM",
        "finish": "foil",
        "delta": 1,
        "reason": "x",
    }
    body.update(overrides)
    return body


def test_missing_tenant_header_is_401(client):
    cust = uuid.uuid4()
    assert client.get("/v1/inventory").status_code == 401
    assert client.get(f"/v1/customers/{cust}/credit").status_code == 401
    resp = client.post(
        f"/v1/customers/{cust}/credit/issue",
        json={"amount_cents": 100, "reason": "x"},
        headers={"X-Actor": "a"},
    )
    assert resp.status_code == 401
    resp = client.post("/v1/inventory/adjust", json=_adjust(), headers={"X-Actor": "a"})
    assert resp.status_code == 401


def test_malformed_tenant_header_is_400(client):
    resp = client.get("/v1/inventory", headers={"X-Tenant-Id": "not-a-uuid"})
    assert resp.status_code == 400


def test_writes_require_actor(client):
    resp = client.post(
        "/v1/inventory/adjust", json=_adjust(), headers={"X-Tenant-Id": str(uuid.uuid4())}
    )
    assert resp.status_code == 401


def test_actor_is_bounded_and_nul_free(client):
    from fastapi import HTTPException

    from tcg_pos_api.deps import actor

    assert actor("  alice ") == "alice"
    for bad in ("a" * 201, "al\x00ice"):
        with pytest.raises(HTTPException) as exc:
            actor(bad)
        assert exc.value.status_code == 400
