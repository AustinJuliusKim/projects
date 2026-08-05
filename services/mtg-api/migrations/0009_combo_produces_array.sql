-- Replaces card_combo_pairs.sample_produces (a comma-joined string) with a
-- real text[] so the API can hand callers a structured list instead of
-- asking them to re-split a prose string. `UPDATE ... string_to_array(...,
-- ', ')` below is best-effort for whatever rows already exist: it's the
-- inverse of the ", ".join() that wrote sample_produces in the first place,
-- so it mis-splits the rare feature name that itself contains ", " (none
-- known today). The next `make sync-combos` run writes `produces` directly
-- from Commander Spellbook's per-feature names (no join/split round-trip)
-- and overwrites every row, so this is a one-time, self-healing conversion.
ALTER TABLE card_combo_pairs ADD COLUMN produces text[];

UPDATE card_combo_pairs
SET produces = string_to_array(sample_produces, ', ')
WHERE sample_produces IS NOT NULL;

ALTER TABLE card_combo_pairs DROP COLUMN sample_produces;
