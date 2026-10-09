-- Phase A of the TCG Pricing API (vault: "TCG Pricing API Design 2026-09"
-- §8). Scryfall already ships the TCGplayer and Cardmarket product ids on
-- every printing, but transform.printing_row dropped them, so nothing could
-- join our printings to a marketplace. They are the join keys every price
-- source uses (MTGJSON, Cardmarket's price guide, JustTCG), with
-- (set_code, collector_number) as the universal fallback — hence the index.
--
-- The ids are part of printing_row's content_hash, so the first ingest after
-- this migration rewrites every printing once to backfill them; after that
-- they only change when Scryfall changes them.
--
-- price_updated_at gives the legacy Scryfall price columns the timestamp they
-- never had: load.update_prices bumps it inside its IS DISTINCT FROM guard,
-- so it records when a price last actually changed, not when we last looked.
ALTER TABLE printings
  ADD COLUMN tcgplayer_id integer,
  ADD COLUMN tcgplayer_etched_id integer,
  ADD COLUMN cardmarket_id integer,
  ADD COLUMN price_updated_at timestamptz;

CREATE INDEX printings_set_collector_idx ON printings (set_code, collector_number);
CREATE INDEX printings_tcgplayer_id_idx ON printings (tcgplayer_id) WHERE tcgplayer_id IS NOT NULL;
CREATE INDEX printings_cardmarket_id_idx ON printings (cardmarket_id) WHERE cardmarket_id IS NOT NULL;
