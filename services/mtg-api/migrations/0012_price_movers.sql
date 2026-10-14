-- Phase B of the TCG Pricing API. Movers are computed once per snapshot and
-- stored, so every caller sees the same list for a given snapshot_id
-- (design §6.7: "deterministic movers"). Only the top N per window and
-- direction are kept; the API never ranks on the fly.
CREATE TABLE price_movers (
  snapshot_seq bigint NOT NULL REFERENCES price_snapshots (seq),
  window_days integer NOT NULL CHECK (window_days IN (1, 7, 30)),
  direction text NOT NULL CHECK (direction IN ('up', 'down')),
  rank integer NOT NULL CHECK (rank >= 1),
  sku_id bigint NOT NULL REFERENCES skus (id),
  source_id smallint NOT NULL REFERENCES price_sources (id),
  price_cents integer NOT NULL,
  change numeric(10, 4) NOT NULL,
  PRIMARY KEY (snapshot_seq, window_days, direction, rank)
);

-- History rows are immutable: a correction is a new snapshot revision, never
-- an edit (design §6.2). Retention drops whole monthly partitions, which
-- does not fire row triggers.
CREATE FUNCTION reject_price_daily_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'price_daily is append-only; write a new snapshot revision instead';
END;
$$;

CREATE TRIGGER price_daily_append_only
  BEFORE UPDATE OR DELETE ON price_daily
  FOR EACH ROW EXECUTE FUNCTION reject_price_daily_change();
