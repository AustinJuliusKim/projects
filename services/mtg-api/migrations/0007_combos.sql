-- Known-combo signal for the similarity engine (fixes the recall@10 gate —
-- see docs/PLAN.md and OPS.md phase 3). Diagnosed empirically: most famous
-- combo pairs share no oracle-text vocabulary (a rules interaction, not a
-- textual similarity), so cosine-similarity search structurally can't find
-- them — 70% of the golden set's pairs weren't even in the top-200
-- candidate pool. This table is populated by scripts/sync_combos.py from
-- Commander Spellbook's bulk export (json.commanderspellbook.com), which
-- catalogs known 2+ card combos with real Scryfall oracle_ids attached —
-- rules-based combo data, not decklist co-occurrence, so it doesn't touch
-- the "not decklist co-occurrence" design decision at all.
--
-- One row per unordered pair of cards that co-appear in at least one
-- Commander Spellbook combo variant. `oracle_id_a < oracle_id_b` always
-- (canonicalized ordering — stored once, code looks up both directions).
-- `strength` sums 1/variant_card_count across every variant containing the
-- pair, so a pair found together in a tight 2-card combo counts for more
-- than one only incidentally co-membered in a sprawling 5-card combo, and
-- pairs appearing in multiple distinct combos accumulate strength.
CREATE TABLE card_combo_pairs (
  oracle_id_a uuid NOT NULL REFERENCES cards (oracle_id) ON DELETE CASCADE,
  oracle_id_b uuid NOT NULL REFERENCES cards (oracle_id) ON DELETE CASCADE,
  combo_count integer NOT NULL,
  strength double precision NOT NULL,
  sample_produces text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (oracle_id_a, oracle_id_b),
  CONSTRAINT card_combo_pairs_ordered CHECK (oracle_id_a < oracle_id_b)
);

-- Lookup is always "combo partners of this one card" — need both sides
-- indexed since the pair is stored once but queried from either card.
CREATE INDEX card_combo_pairs_b_idx ON card_combo_pairs (oracle_id_b);
