"""Shared API-key format/hashing helpers — used by scripts/issue_key.py (to
mint and revoke keys) and mtg_api.ratelimit (to look one up). The database
only ever stores key_sha256; plaintext keys are never persisted or logged
anywhere (services/guided-repl-api/src/sessions.js precedent)."""

import hashlib
import secrets

KEY_PREFIX = "mtg_live_"
TIERS = ("free", "supporter")

_HEX64_RE_CHARS = set("0123456789abcdef")


def generate_key() -> str:
    """A fresh plaintext key, permanent once issued: mtg_live_ + 32 hex chars."""
    return f"{KEY_PREFIX}{secrets.token_hex(16)}"


def hash_key(key: str) -> str:
    """sha256 hex of a plaintext key — the only form ever written to the
    database or compared against it."""
    return hashlib.sha256(key.encode()).hexdigest()


def resolve_key_sha256(value: str) -> str:
    """Accept either a plaintext mtg_live_... key or an already-hashed
    64-hex sha256 and return the sha256 hex (scripts/issue_key.py --revoke
    takes either form)."""
    value = value.strip()
    lowered = value.lower()
    if len(lowered) == 64 and set(lowered) <= _HEX64_RE_CHARS:
        return lowered
    return hash_key(value)
