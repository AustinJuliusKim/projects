-- Suggestion feedback log, written by the webapp from day one (impressions,
-- clicks, deck-adds, dismissals on /similar results). This is the training
-- data the eventual reranker/model needs — docs/PLAN.md sets ~10k events as
-- the earliest sensible training threshold. Append-only; no reads in the
-- API yet.

CREATE TABLE suggestion_events (
  id bigserial PRIMARY KEY,
  event text NOT NULL CHECK (event IN ('impression', 'click', 'deck_add', 'dismiss')),
  seed_oracle_id uuid NOT NULL REFERENCES cards (oracle_id) ON DELETE CASCADE,
  suggested_oracle_id uuid NOT NULL REFERENCES cards (oracle_id) ON DELETE CASCADE,
  confidence numeric,
  context text, -- e.g. 'card_page', 'deck_builder'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX suggestion_events_seed_idx ON suggestion_events (seed_oracle_id, created_at);
