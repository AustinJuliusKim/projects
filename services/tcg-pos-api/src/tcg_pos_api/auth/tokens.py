"""Bearer access-token verification (Cognito in production, the dev issuer
locally — auth/dev.py). The token is used only to learn WHO is calling
(`sub`); what they may do is resolved from Postgres per request.

Config (environment):
  AUTH_ISSUER      the exact `iss` to accept (Cognito:
                   https://cognito-idp.<region>.amazonaws.com/<pool id>).
  AUTH_CLIENT_IDS  comma list of app client ids (`client_id` claim).
  AUTH_JWKS_URL    defaults to {issuer}/.well-known/jwks.json, or to the dev
                   key file when AUTH_ISSUER is the dev issuer. https:// or
                   file:// (file is for the dev issuer and tests).

Checks: RS256 only (alg pinned, so `none` and HS256-with-the-public-key are
refused); signature against the JWKS key named by `kid` (an unknown kid
refetches the JWKS, at most every 30 s); iss; token_use == "access" (an ID
token is refused); client_id in AUTH_CLIENT_IDS; exp with 30 s leeway;
sub/iat present. Cognito access tokens have no `aud`, so none is required.

JWKS clients are module-level and cached per URL, so keys survive across
warm Lambda invocations."""

import dataclasses
import json
import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError

from tcg_pos_api.auth.dev import DEV_CLIENT_ID, DEV_ISSUER, jwks_path

ALGORITHMS = ["RS256"]
LEEWAY_SECONDS = 30
TOKEN_MAX_BYTES = 8192
SUB_MAX = 200


class InvalidToken(Exception):
    """The token is missing, malformed, or fails verification (401)."""


class AuthUnavailable(Exception):
    """The issuer's keys couldn't be fetched (503, not the caller's fault)."""


@dataclasses.dataclass(frozen=True)
class AuthSettings:
    issuer: str
    client_ids: frozenset[str]
    jwks_url: str

    @property
    def is_dev(self) -> bool:
        return self.issuer == DEV_ISSUER


@dataclasses.dataclass(frozen=True)
class Claims:
    sub: str
    client_id: str
    email: str | None
    raw: dict[str, Any]


def settings() -> AuthSettings:
    issuer = os.environ.get("AUTH_ISSUER", "").strip()
    if not issuer:
        raise RuntimeError("AUTH_ISSUER is required")
    client_ids = frozenset(
        c.strip() for c in os.environ.get("AUTH_CLIENT_IDS", "").split(",") if c.strip()
    )
    if not client_ids and issuer == DEV_ISSUER:
        client_ids = frozenset({DEV_CLIENT_ID})
    if not client_ids:
        raise RuntimeError("AUTH_CLIENT_IDS is required")
    jwks_url = os.environ.get("AUTH_JWKS_URL", "").strip()
    if not jwks_url:
        if issuer == DEV_ISSUER:
            jwks_url = jwks_path().resolve().as_uri()
        else:
            jwks_url = f"{issuer.rstrip('/')}/.well-known/jwks.json"
    return AuthSettings(issuer=issuer, client_ids=client_ids, jwks_url=jwks_url)


class FileJWKClient(PyJWKClient):
    """PyJWKClient over a local JWKS file (the dev issuer; tests). PyJWT
    refuses non-http(s) URIs, so the URL here is a placeholder and
    fetch_data reads the file. No refetch cooldown: a re-generated dev key
    is picked up on the next unknown kid."""

    def __init__(self, path: Path):
        super().__init__("https://jwks.file.invalid/", cooldown_duration=0)
        self.path = path

    def fetch_data(self) -> Any:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError) as err:
            raise PyJWKClientConnectionError(f"can't read JWKS file {self.path}: {err}") from err
        if self.jwk_set_cache is not None:
            self.jwk_set_cache.put(data)
        self._last_successful_fetch = time.monotonic()
        return data


_clients: dict[str, PyJWKClient] = {}
_clients_lock = threading.Lock()


def jwk_client(url: str) -> PyJWKClient:
    with _clients_lock:
        client = _clients.get(url)
        if client is None:
            parsed = urlparse(url)
            if parsed.scheme == "file":
                client = FileJWKClient(Path(unquote(parsed.path)))
            elif parsed.scheme in ("http", "https"):
                client = PyJWKClient(url, timeout=5)
            else:
                raise RuntimeError(f"AUTH_JWKS_URL must be https:// or file://, got {url!r}")
            _clients[url] = client
        return client


def verify_access_token(token: str, auth: AuthSettings | None = None) -> Claims:
    """Verify an access token and return its claims, or raise InvalidToken
    (AuthUnavailable when the JWKS can't be fetched)."""
    auth = auth or settings()
    if not token or len(token) > TOKEN_MAX_BYTES:
        raise InvalidToken("malformed token")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise InvalidToken("malformed token") from None
    if header.get("alg") not in ALGORITHMS:
        raise InvalidToken("unsupported token algorithm")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise InvalidToken("token has no key id")
    try:
        key = jwk_client(auth.jwks_url).get_signing_key(kid).key
    except PyJWKClientConnectionError as err:
        raise AuthUnavailable(str(err)) from None
    except PyJWKClientError:
        raise InvalidToken("unknown signing key") from None
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=ALGORITHMS,
            issuer=auth.issuer,
            leeway=LEEWAY_SECONDS,
            options={
                "require": ["exp", "iat", "iss", "sub", "token_use", "client_id"],
                "verify_aud": False,
            },
        )
    except jwt.ExpiredSignatureError:
        raise InvalidToken("token expired") from None
    except jwt.PyJWTError:
        raise InvalidToken("invalid token") from None
    if claims.get("token_use") != "access":
        raise InvalidToken("not an access token")
    if claims.get("client_id") not in auth.client_ids:
        raise InvalidToken("token is for another client")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.strip() or len(sub) > SUB_MAX or "\x00" in sub:
        raise InvalidToken("invalid subject")
    email = claims.get("email")
    if not isinstance(email, str) or not email.strip():
        email = None
    return Claims(
        sub=sub,
        client_id=claims["client_id"],
        email=email.strip().lower() if email else None,
        raw=claims,
    )
