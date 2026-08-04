"""Key format + hashing helpers — pure functions, no DB needed."""

import hashlib

from mtg_api import apikeys


def test_generate_key_matches_the_frozen_format():
    key = apikeys.generate_key()
    assert key.startswith(apikeys.KEY_PREFIX)
    hex_part = key[len(apikeys.KEY_PREFIX) :]
    assert len(hex_part) == 32
    int(hex_part, 16)  # raises if not valid hex


def test_generate_key_is_random():
    assert apikeys.generate_key() != apikeys.generate_key()


def test_hash_key_round_trips_and_is_sha256():
    key = apikeys.generate_key()
    hashed = apikeys.hash_key(key)
    assert hashed == apikeys.hash_key(key)  # deterministic
    assert hashed == hashlib.sha256(key.encode()).hexdigest()
    assert len(hashed) == 64
    assert hashed != key  # plaintext never equals what's stored


def test_hash_key_differs_across_keys():
    assert apikeys.hash_key(apikeys.generate_key()) != apikeys.hash_key(apikeys.generate_key())


def test_resolve_key_sha256_hashes_plaintext():
    key = apikeys.generate_key()
    assert apikeys.resolve_key_sha256(key) == apikeys.hash_key(key)


def test_resolve_key_sha256_passes_through_a_hash():
    hashed = apikeys.hash_key(apikeys.generate_key())
    assert apikeys.resolve_key_sha256(hashed) == hashed
    assert apikeys.resolve_key_sha256(hashed.upper()) == hashed
