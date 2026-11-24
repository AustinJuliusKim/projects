"""POST /v1/me/identity (A4): a Cognito user's email and name come from
their verified ID token, since access tokens carry none. Plus the per-user
store cap and rate limit on POST /v1/stores. Skipped without
TEST_DATABASE_URL."""

import logging
import re
import uuid

import pytest

from conftest import (
    TEST_CLIENT_ID,
    TEST_ISSUER,
    TEST_KEY,
    TEST_KID,
    headers,
    mint,
    requires_db,
)
from tcg_pos_api.auth.dev import generate_key, id_claims, key_id, sign

pytestmark = requires_db


def cognito_user():
    """A user whose access token, like Cognito's, has no email."""
    sub = f"cognito|{uuid.uuid4()}"
    return sub, {"Authorization": f"Bearer {mint(sub)}"}


def id_token(sub, email="pat@example.test", key=TEST_KEY, kid=TEST_KID, **overrides):
    claims = id_claims(
        sub=sub, issuer=TEST_ISSUER, client_id=TEST_CLIENT_ID, email=email or "unused@x.test"
    )
    claims.update(email=email, **overrides)  # email=None drops the claim
    return sign(key, {k: v for k, v in claims.items() if v is not None}, kid=kid)


def sync(client, h, token):
    return client.post("/v1/me/identity", json={"id_token": token}, headers=h)


def test_id_token_sets_email_and_name(client):
    sub, h = cognito_user()
    assert client.get("/v1/me", headers=h).json()["user"]["email"] is None
    resp = sync(client, h, id_token(sub, email=" Pat@Example.TEST ", name="  Pat   Smith "))
    assert resp.status_code == 200, resp.text
    user = resp.json()["user"]
    assert (user["email"], user["display_name"]) == ("pat@example.test", "Pat Smith")
    me = client.get("/v1/me", headers=h).json()["user"]
    assert (me["email"], me["display_name"]) == ("pat@example.test", "Pat Smith")
    # given/family names work too; a token without a name keeps the old one.
    resp = sync(
        client, h, id_token(sub, email="pat2@example.test", given_name="P", family_name="S")
    )
    assert resp.json()["user"]["display_name"] == "P S"
    resp = sync(client, h, id_token(sub, email="pat2@example.test"))
    assert resp.json()["user"]["display_name"] == "P S"


@pytest.mark.parametrize(
    "case",
    [
        "other_sub",
        "unverified",
        "unverified_str",
        "wrong_aud",
        "no_email",
        "access_token",
        "expired",
        "wrong_key",
        "wrong_iss",
        "garbage",
    ],
)
def test_bad_id_tokens_are_refused(client, case):
    sub, h = cognito_user()
    token = {
        "other_sub": lambda: id_token("cognito|someone-else"),
        "unverified": lambda: id_token(sub, email_verified=False),
        "unverified_str": lambda: id_token(sub, email_verified="false"),
        "wrong_aud": lambda: id_token(sub, aud="another-client"),
        "no_email": lambda: id_token(sub, email=None),
        "access_token": lambda: mint(sub, email="pat@example.test"),
        "expired": lambda: id_token(sub, exp=1_000_000, iat=999_000),
        "wrong_key": lambda: id_token(sub, key=(k := generate_key()), kid=key_id(k.public_key())),
        "wrong_iss": lambda: id_token(sub, iss="https://elsewhere.test"),
        "garbage": lambda: "x" * 40,
    }[case]()
    resp = sync(client, h, token)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["reason"] == "invalid_id_token"
    assert client.get("/v1/me", headers=h).json()["user"]["email"] is None


def test_id_token_needs_a_bearer_access_token(client):
    sub, _ = cognito_user()
    assert sync(client, {}, id_token(sub)).status_code == 401
    # An ID token is not an access token either.
    resp = client.get("/v1/me", headers={"Authorization": f"Bearer {id_token(sub)}"})
    assert resp.status_code == 401


def test_invite_acceptance_uses_the_synced_email(client, make_tenant, caplog):
    caplog.set_level(logging.INFO, logger="tcg_pos_api.invites")
    t = make_tenant()
    owner = headers(t, actor="identity-owner")
    email = f"cog-{uuid.uuid4().hex[:8]}@example.test"
    assert (
        client.post(
            "/v1/invites", json={"email": email, "role": "cashier"}, headers=owner
        ).status_code
        == 201
    )
    token = re.search(r"token=(\S+)", caplog.records[-1].getMessage()).group(1)

    sub, h = cognito_user()
    resp = client.post("/v1/invites/accept", json={"token": token}, headers=h)
    assert resp.status_code == 403  # no email known yet
    # An unverified email doesn't count.
    assert sync(client, h, id_token(sub, email=email, email_verified=False)).status_code == 422
    assert client.post("/v1/invites/accept", json={"token": token}, headers=h).status_code == 403
    assert sync(client, h, id_token(sub, email=email)).status_code == 200
    resp = client.post("/v1/invites/accept", json={"token": token}, headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"tenant_id": str(t["id"]), "role": "cashier"}


# --- store creation cap + rate limit -------------------------------------------------


def _create(client, h, name="Shop"):
    return client.post("/v1/stores", json={"name": name}, headers=h)


def test_store_creation_is_capped_per_user(client, monkeypatch):
    monkeypatch.setenv("MAX_OWNED_STORES", "2")
    monkeypatch.setenv("STORE_CREATE_LIMIT", "100")
    _, h = cognito_user()
    assert [_create(client, h).status_code for _ in range(2)] == [201, 201]
    resp = _create(client, h)
    assert resp.status_code == 403
    assert resp.json() == {"detail": {"reason": "store_limit", "limit": 2}}
    assert len(client.get("/v1/me", headers=h).json()["stores"]) == 2
    # Someone else isn't affected.
    _, other = cognito_user()
    assert _create(client, other).status_code == 201


def test_store_creation_is_rate_limited_per_user(client, monkeypatch):
    monkeypatch.setenv("STORE_CREATE_LIMIT", "1")
    _, h = cognito_user()
    assert _create(client, h).status_code == 201
    resp = _create(client, h)
    assert resp.status_code == 429 and "retry-after" in resp.headers
    assert len(client.get("/v1/me", headers=h).json()["stores"]) == 1
