-- API keys for third-party access (Phase 5, docs/PLAN.md). Card data itself
-- is never paywalled: anonymous requests reach every card-data endpoint at a
-- modest limit, and a key only buys a higher one. Only the sha256 hex of
-- each key is ever stored (services/guided-repl-api/src/sessions.js
-- precedent) — a DB leak reveals no usable key, and scripts/issue_key.py
-- prints the plaintext exactly once at issue time and never logs it.
--
-- rate_counters backs the fixed-window limiter in
-- src/mtg_api/ratelimit.py: one row per (identifier, minute), bumped by a
-- plain INSERT ... ON CONFLICT DO UPDATE SET count = count + 1. The limiter
-- fails open on any error touching this table — availability over strict
-- enforcement at this traffic level. Pruning is opportunistic-on-write (no
-- separate cron/job): whenever an increment creates a brand-new window row,
-- that same request also deletes rows older than 1 hour.

CREATE TABLE api_keys (
  id bigserial PRIMARY KEY,
  key_sha256 text NOT NULL UNIQUE,
  tier text NOT NULL CHECK (tier IN ('free', 'supporter')),
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE rate_counters (
  identifier text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (identifier, window_start)
);

-- The opportunistic prune deletes by age; without this the delete is a
-- sequential scan that grows with exactly the junk-identifier load it
-- exists to bound.
CREATE INDEX rate_counters_window_start_idx ON rate_counters (window_start);
