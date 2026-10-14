"""Access-token verification (auth/tokens.py) against a local RSA key and a
JWKS fixture, plus the dev issuer's guard rails. No database needed."""

import base64
import hashlib
import hmac
import http.server
import json
import threading
import time

import pytest
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from conftest import JWKS_FILE, TEST_CLIENT_ID, TEST_ISSUER, TEST_KEY, TEST_KID, mint
from tcg_pos_api.auth import dev as dev_auth
from tcg_pos_api.auth import tokens
from tcg_pos_api.auth.tokens import AuthSettings, InvalidToken, verify_access_token

SUB = "11111111-2222-3333-4444-555555555555"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unsigned(header: dict, claims: dict, signature: bytes = b"") -> str:
    head = _b64(json.dumps(header).encode())
    body = _b64(json.dumps(claims).encode())
    return f"{head}.{body}.{_b64(signature)}"


def _claims(**overrides):
    claims = dev_auth.access_claims(sub=SUB, issuer=TEST_ISSUER, client_id=TEST_CLIENT_ID)
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not None}


def _rejects(token, match=None):
    with pytest.raises(InvalidToken, match=match):
        verify_access_token(token)


def test_valid_access_token():
    claims = verify_access_token(mint(SUB, email=" Pat@Example.COM "))
    assert claims.sub == SUB and claims.client_id == TEST_CLIENT_ID
    assert claims.email == "pat@example.com"
    assert verify_access_token(mint(SUB)).email is None


def test_alg_none_is_rejected():
    _rejects(_unsigned({"alg": "none", "typ": "JWT", "kid": TEST_KID}, _claims()), "algorithm")
    _rejects(_unsigned({"alg": "none", "kid": TEST_KID}, _claims(), b"sig"), "algorithm")


def test_hs256_signed_with_the_public_key_is_rejected():
    """Algorithm confusion: an HMAC signature keyed with the (public) RSA key."""
    pem = TEST_KEY.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    header = {"alg": "HS256", "typ": "JWT", "kid": TEST_KID}
    unsigned = _unsigned(header, _claims()).rsplit(".", 1)[0]
    sig = hmac.new(pem, unsigned.encode(), hashlib.sha256).digest()
    _rejects(f"{unsigned}.{_b64(sig)}", "algorithm")
    # Lying in the header (RS256) doesn't help: the HMAC isn't an RSA signature.
    header["alg"] = "RS256"
    unsigned = _unsigned(header, _claims()).rsplit(".", 1)[0]
    sig = hmac.new(pem, unsigned.encode(), hashlib.sha256).digest()
    _rejects(f"{unsigned}.{_b64(sig)}", "invalid token")


def test_wrong_issuer_or_client_is_rejected():
    _rejects(mint(SUB, iss="https://evil.example/pool"), "invalid token")
    _rejects(mint(SUB, iss=None), "invalid token")
    _rejects(mint(SUB, client_id="someone-elses-app"), "another client")
    _rejects(mint(SUB, client_id=None), "invalid token")


def test_id_token_is_not_an_access_token():
    # A Cognito ID token: token_use "id", `aud` instead of `client_id`.
    _rejects(mint(SUB, token_use="id", aud=TEST_CLIENT_ID, client_id=None))
    _rejects(mint(SUB, token_use="id"), "not an access token")
    _rejects(mint(SUB, token_use=None), "invalid token")


def test_expiry_with_leeway():
    now = int(time.time())
    _rejects(mint(SUB, iat=now - 3600, exp=now - 31 - 5), "expired")
    assert verify_access_token(mint(SUB, iat=now - 3600, exp=now - 10)).sub == SUB
    _rejects(mint(SUB, exp=None), "invalid token")


def test_unknown_kid_and_wrong_key_are_rejected():
    other = dev_auth.generate_key()
    # Signed by a key the JWKS doesn't have (its own kid): unknown kid.
    _rejects(mint(SUB, key=other, kid=dev_auth.key_id(other.public_key())), "unknown")
    # Signed by another key but claiming our kid: bad signature.
    _rejects(mint(SUB, key=other), "invalid token")
    # No kid at all.
    rest = dev_auth.sign(TEST_KEY, _claims(), kid="x").split(".", 1)[1]
    no_kid = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    _rejects(f"{no_kid}.{rest}", "key id")


def test_missing_or_bad_sub_is_rejected():
    _rejects(mint(None), "invalid token")
    _rejects(mint(""), "invalid")
    _rejects(mint("   "), "invalid subject")
    _rejects(mint("x" * 201), "invalid subject")


def test_garbage_is_rejected():
    for token in ("", "abc", "a.b.c", "x" * 9000):
        _rejects(token)


def test_tampered_claims_are_rejected():
    token = mint(SUB)
    head, body, sig = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(body + "=="))
    claims["sub"] = "someone-else"
    _rejects(f"{head}.{_b64(json.dumps(claims).encode())}.{sig}", "invalid token")


def test_expired_token_is_401_through_the_api():
    from tcg_pos_api.app import create_app

    now = int(time.time())
    with TestClient(create_app()) as client:
        resp = client.get(
            "/v1/me",
            headers={"Authorization": f"Bearer {mint(SUB, iat=now - 7200, exp=now - 3600)}"},
        )
    assert resp.status_code == 401 and resp.json()["detail"] == "token expired"


def test_https_jwks_endpoint():
    """The production path: PyJWKClient fetching a JWKS over HTTP."""
    jwks = json.dumps({"keys": [dev_auth.public_jwk(TEST_KEY.public_key(), TEST_KID)]}).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(jwks)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/.well-known/jwks.json"
        auth = AuthSettings(TEST_ISSUER, frozenset({TEST_CLIENT_ID}), url)
        assert verify_access_token(mint(SUB), auth).sub == SUB
        other = dev_auth.generate_key()
        with pytest.raises(InvalidToken):
            verify_access_token(mint(SUB, key=other, kid="rotated"), auth)
    finally:
        server.shutdown()


def test_jwks_unreachable_is_auth_unavailable():
    auth = AuthSettings(TEST_ISSUER, frozenset({TEST_CLIENT_ID}), "http://127.0.0.1:9/jwks.json")
    with pytest.raises(tokens.AuthUnavailable):
        verify_access_token(mint(SUB), auth)


def test_settings_defaults(monkeypatch):
    monkeypatch.setenv("AUTH_ISSUER", "https://cognito-idp.us-west-2.amazonaws.com/pool")
    monkeypatch.setenv("AUTH_CLIENT_IDS", " a , b ,")
    monkeypatch.delenv("AUTH_JWKS_URL")
    s = tokens.settings()
    assert s.client_ids == {"a", "b"} and not s.is_dev
    assert s.jwks_url == "https://cognito-idp.us-west-2.amazonaws.com/pool/.well-known/jwks.json"
    monkeypatch.setenv("AUTH_CLIENT_IDS", "")
    with pytest.raises(RuntimeError, match="AUTH_CLIENT_IDS"):
        tokens.settings()
    monkeypatch.delenv("AUTH_ISSUER")
    with pytest.raises(RuntimeError, match="AUTH_ISSUER"):
        tokens.settings()


# --- dev issuer ----------------------------------------------------------------------


@pytest.fixture
def dev_env(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ISSUER", dev_auth.DEV_ISSUER)
    monkeypatch.delenv("AUTH_CLIENT_IDS")
    monkeypatch.delenv("AUTH_JWKS_URL")
    monkeypatch.setenv("DEV_AUTH_DIR", str(tmp_path / "auth"))
    return tmp_path / "auth"


@pytest.mark.parametrize("env", ["", "prod", "staging", "LOCALISH"])
def test_dev_issuer_refuses_to_start_outside_local_and_test(dev_env, monkeypatch, env):
    from tcg_pos_api.app import create_app

    monkeypatch.setenv("ENV", env)
    with pytest.raises(RuntimeError, match="dev issuer"):
        create_app()


def test_app_refuses_to_start_without_an_issuer(monkeypatch):
    from tcg_pos_api.app import create_app

    monkeypatch.delenv("AUTH_ISSUER")
    with pytest.raises(RuntimeError, match="AUTH_ISSUER"):
        create_app()


def test_dev_login_mints_verifiable_tokens(dev_env, monkeypatch):
    from tcg_pos_api.app import create_app

    monkeypatch.setenv("ENV", "local")
    with TestClient(create_app()) as client:
        resp = client.post("/v1/dev/login", json={"email": " Dev@Example.Test "})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["sub"] == dev_auth.dev_sub("dev@example.test")
    claims = verify_access_token(body["access_token"])
    assert (claims.sub, claims.email) == (body["sub"], "dev@example.test")
    identity = tokens.verify_id_token(body["id_token"], expected_sub=body["sub"])
    assert identity.email == "dev@example.test"
    # Keys landed in the (temp) dev dir, private key not world-readable.
    assert (dev_env / "jwks.json").exists()
    assert (dev_env / "private.pem").stat().st_mode & 0o077 == 0
    # A dev token is not accepted by an app configured for a real issuer.
    monkeypatch.setenv("AUTH_ISSUER", TEST_ISSUER)
    monkeypatch.setenv("AUTH_CLIENT_IDS", TEST_CLIENT_ID)
    monkeypatch.setenv("AUTH_JWKS_URL", JWKS_FILE.as_uri())
    with pytest.raises(InvalidToken):
        verify_access_token(body["access_token"])
