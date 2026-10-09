-- Fixes from the pricing phase A–C review.
--
-- change_* were numeric(10, 4), so one absurd move (a 1¢ bulk price followed
-- by a bogus $10,000 listing) overflowed and aborted the whole day's
-- snapshot. Unconstrained numeric stores any ratio; movers filter absurd
-- ones instead (snapshot.MOVERS_MAX_CHANGE).
ALTER TABLE price_current
  ALTER COLUMN change_1d TYPE numeric,
  ALTER COLUMN change_7d TYPE numeric,
  ALTER COLUMN change_30d TYPE numeric;
ALTER TABLE price_movers ALTER COLUMN change TYPE numeric;

-- Batch lookups by tcgplayer_id OR tcgplayer_etched_id seq-scanned printings
-- without this (the OR can only use a BitmapOr when both sides are indexed).
CREATE INDEX printings_tcgplayer_etched_id_idx ON printings (tcgplayer_etched_id)
  WHERE tcgplayer_etched_id IS NOT NULL;

-- Staleness is now measured from when a feed was *published*, not when our
-- job last ran. MTGJSON stamps its files with a date only (midnight UTC) and
-- the 21:00 snapshot reads the previous day's build, so it is ~45h old on a
-- healthy day; give it a full extra day before calling it stale.
UPDATE price_sources SET stale_after_hours = 60 WHERE feed = 'mtgjson';
