"""The local dev issuer: an RSA key pair under .dev/auth/ (gitignored) that
signs RS256 access tokens shaped like Cognito's, so local dev and tests run
the exact verification path production does — no header bypass.

  * The verifier reads the dev issuer's JWKS from .dev/auth/jwks.json
    (AUTH_JWKS_URL defaults to it when AUTH_ISSUER is DEV_ISSUER).
  * scripts/dev_token.py mints tokens; POST /v1/dev/login exists only when
    AUTH_ISSUER is DEV_ISSUER, and the app refuses to start with the dev
    issuer unless ENV is local or test (app.create_app).
  * Dev tokens carry `email` (Cognito access tokens don't; there the email
    comes from the ID token / userinfo). `sub` is a stable UUID derived from
    the email, so the same address is the same user across restarts."""

import base64
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

DEV_ISSUER = "urn:tcg-pos:dev-issuer"
DEV_CLIENT_ID = "tcg-pos-dev"
DEV_ENVS = frozenset({"local", "test"})
DEFAULT_TTL_SECONDS = 12 * 3600

SERVICE_DIR = Path(__file__).resolve().parents[3]
_SUB_NAMESPACE = uuid.UUID("5d1e3b0c-7d0e-4a8e-9c55-2f0b6c1a9e41")


def dev_auth_dir() -> Path:
    return Path(os.environ.get("DEV_AUTH_DIR") or SERVICE_DIR / ".dev" / "auth")


def jwks_path(directory: Path | None = None) -> Path:
    return (directory or dev_auth_dir()) / "jwks.json"


def private_key_path(directory: Path | None = None) -> Path:
    return (directory or dev_auth_dir()) / "private.pem"


def dev_sub(email: str) -> str:
    """The dev issuer's stable `sub` for an email address."""
    return str(uuid.uuid5(_SUB_NAMESPACE, email.strip().lower()))


def key_id(public_key: rsa.RSAPublicKey) -> str:
    """RFC 7638 JWK thumbprint (SHA-256, base64url)."""
    jwk = RSAAlgorithm.to_jwk(public_key, as_dict=True)
    canonical = json.dumps({k: jwk[k] for k in ("e", "kty", "n")}, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def public_jwk(public_key: rsa.RSAPublicKey, kid: str | None = None) -> dict[str, Any]:
    jwk = RSAAlgorithm.to_jwk(public_key, as_dict=True)
    return {**jwk, "kid": kid or key_id(public_key), "use": "sig", "alg": "RS256"}


def generate_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def ensure_keypair(directory: Path | None = None) -> Path:
    """Create the dev key pair and its JWKS if missing. Returns the dir."""
    directory = directory or dev_auth_dir()
    priv, jwks = private_key_path(directory), jwks_path(directory)
    if priv.exists() and jwks.exists():
        return directory
    directory.mkdir(parents=True, exist_ok=True)
    key = generate_key()
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    fd = os.open(priv, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    jwks.write_text(json.dumps({"keys": [public_jwk(key.public_key())]}, indent=2))
    return directory


def load_private_key(directory: Path | None = None) -> rsa.RSAPrivateKey:
    data = private_key_path(directory).read_bytes()
    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise RuntimeError("dev auth key is not an RSA key")
    return key


def access_claims(
    *,
    sub: str,
    issuer: str,
    client_id: str,
    email: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
    now: int | None = None,
) -> dict[str, Any]:
    """Claims shaped like a Cognito access token (plus `email`)."""
    now = int(time.time()) if now is None else now
    claims = {
        "sub": sub,
        "iss": issuer,
        "client_id": client_id,
        "token_use": "access",
        "scope": "openid email",
        "auth_time": now,
        "iat": now,
        "exp": now + ttl,
        "jti": str(uuid.uuid4()),
        "username": sub,
    }
    if email:
        claims["email"] = email.strip().lower()
    return claims


def sign(key: rsa.RSAPrivateKey, claims: dict[str, Any], *, kid: str | None = None) -> str:
    kid = kid or key_id(key.public_key())
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


def mint_dev_token(
    email: str,
    *,
    sub: str | None = None,
    ttl: int = DEFAULT_TTL_SECONDS,
    directory: Path | None = None,
) -> str:
    """A dev-issuer access token for `email` (sub defaults to dev_sub)."""
    ensure_keypair(directory)
    key = load_private_key(directory)
    claims = access_claims(
        sub=sub or dev_sub(email),
        issuer=DEV_ISSUER,
        client_id=DEV_CLIENT_ID,
        email=email,
        ttl=ttl,
    )
    return sign(key, claims)
