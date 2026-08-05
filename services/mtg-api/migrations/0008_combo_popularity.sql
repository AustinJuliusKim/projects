-- Adds Commander Spellbook's per-combo popularity (deck-inclusion count)
-- as a tie-breaker among combo partners tied on strength — a seed with
-- several legitimate known-combo partners needs some way to prefer the
-- famous one over an obscure one when both saturate the strength signal.
-- Backfilled by re-running scripts/sync_combos.py (idempotent upsert).
ALTER TABLE card_combo_pairs ADD COLUMN popularity bigint NOT NULL DEFAULT 0;
