"""Bearer-token and store-selector handling and request validation — all
rejected before any DB connection is opened, so these run without
TEST_DATABASE_URL."""

import uuid

import pytest
from fastapi.testclient import TestClient

from conftest import bearer
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


def test_missing_token_is_401(client):
    cust = uuid.uuid4()
    tenant = {"X-Tenant-Id": str(uuid.uuid4())}
    assert client.get("/v1/inventory").status_code == 401
    assert client.get("/v1/inventory", headers=tenant).status_code == 401
    assert client.get(f"/v1/customers/{cust}/credit", headers=tenant).status_code == 401
    resp = client.post(
        f"/v1/customers/{cust}/credit/issue",
        json={"amount_cents": 100, "reason": "x"},
        headers=tenant,
    )
    assert resp.status_code == 401
    resp = client.post("/v1/inventory/adjust", json=_adjust(), headers=tenant)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def test_x_actor_is_not_an_identity(client):
    """The old X-Actor header authenticates nothing."""
    resp = client.post(
        "/v1/inventory/adjust",
        json=_adjust(),
        headers={"X-Tenant-Id": str(uuid.uuid4()), "X-Actor": "alice"},
    )
    assert resp.status_code == 401


def test_non_bearer_schemes_are_401(client):
    for value in ("Basic dXNlcjpwYXNz", "Bearer", "Bearer ", "token abc"):
        resp = client.get(
            "/v1/inventory", headers={"Authorization": value, "X-Tenant-Id": str(uuid.uuid4())}
        )
        assert resp.status_code == 401, value


def test_store_selector_is_required_and_must_be_a_uuid(client):
    resp = client.get("/v1/inventory", headers=bearer("selector-test"))
    assert resp.status_code == 400 and "X-Tenant-Id" in resp.json()["detail"]
    resp = client.get(
        "/v1/inventory", headers={**bearer("selector-test"), "X-Tenant-Id": "not-a-uuid"}
    )
    assert resp.status_code == 400


def test_dev_login_is_not_mounted_for_a_real_issuer(client):
    assert client.post("/v1/dev/login", json={"email": "a@b.co"}).status_code == 404
