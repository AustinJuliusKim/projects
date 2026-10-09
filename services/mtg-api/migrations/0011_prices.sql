-- Phase A of the TCG Pricing API (vault: "TCG Pricing API Design 2026-09"
-- §5–§8, "Price Data Licensing Lanes"). Price history with provenance, kept
-- apart from the legacy Scryfall columns on printings.
--
-- Rules this schema enforces rather than leaves to code:
--   * Money is integer cents in the source's native currency. No floats, no
--     blended cross-currency number. A missing price is NULL, never 0.
--   * Every source carries a license lane (own / open / licensed / qa-only).
--     The public API filters on it; `licensed` and `qa-only` never leave the
--     database through /v1.
--   * Listing-based and sales-based series are separate sources with a
--     declared `series`, so nothing downstream can average them together.
--   * Snapshots are immutable. price_daily is append-only per snapshot:
--     a snapshot writes a row only where a value changed, tagged with its
--     snapshot_seq, and "history as of snapshot S" reads the latest row with
--     snapshot_seq <= S. Re-running a day makes revision .2 without touching
--     what .1 returned. This is why snapshot_seq joins the design's
--     (sku_id, as_of, source_id) primary key.
--
-- Choices the design left open: text + CHECK instead of enums (adding a game
-- or finish is then one ALTER of a constraint, not an enum migration);
-- skus.printing_id has no FK to printings because ingest hard-deletes
-- printings that leave Scryfall and price history must outlive that.
-- Partitions are plain monthly range partitions created by
-- ensure_price_partitions(), called by the snapshot job before it writes;
-- pg_partman availability on Supabase is unverified.

CREATE TABLE price_sources (
  id smallint PRIMARY KEY,
  code text NOT NULL UNIQUE,
  -- The upstream fetch this source arrives in; ingest_runs.source records the
  -- feed, which is what /v1/prices/status reports lag for.
  feed text NOT NULL,
  name text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('own', 'open', 'licensed', 'qa-only')),
  series text NOT NULL CHECK (series IN ('listings', 'sales', 'reference')),
  currency text NOT NULL CHECK (currency IN ('USD', 'EUR')),
  attribution text NOT NULL,
  -- Expected cadence; a source this many hours past its last success is stale.
  stale_after_hours integer NOT NULL DEFAULT 36
);

-- Seeded here so ids are stable across environments. MTGJSON's Cardhoarder
-- prices are MTGO tix for digital objects and have no paper SKU; not seeded.
INSERT INTO price_sources (id, code, feed, name, lane, series, currency, attribution) VALUES
  (1, 'mtgjson_tcgplayer', 'mtgjson', 'TCGplayer via MTGJSON', 'open', 'reference', 'USD', 'MTGJSON'),
  (2, 'mtgjson_cardkingdom', 'mtgjson', 'Card Kingdom via MTGJSON', 'open', 'reference', 'USD', 'MTGJSON'),
  (3, 'mtgjson_cardsphere', 'mtgjson', 'Cardsphere via MTGJSON', 'open', 'reference', 'USD', 'MTGJSON'),
  (4, 'mtgjson_manapool', 'mtgjson', 'Mana Pool via MTGJSON', 'open', 'reference', 'USD', 'MTGJSON'),
  (5, 'mtgjson_cardmarket', 'mtgjson', 'Cardmarket via MTGJSON', 'open', 'reference', 'EUR', 'MTGJSON'),
  (6, 'cardmarket_guide', 'cardmarket_guide', 'Cardmarket price guide', 'open', 'reference', 'EUR', 'Cardmarket'),
  (7, 'scryfall_usd', 'scryfall', 'Scryfall USD (trend only)', 'open', 'reference', 'USD', 'Scryfall'),
  (8, 'scryfall_eur', 'scryfall', 'Scryfall EUR (trend only)', 'open', 'reference', 'EUR', 'Scryfall'),
  (9, 'tcgcsv', 'tcgcsv', 'TCGCSV (calibration only)', 'qa-only', 'reference', 'USD', 'TCGCSV'),
  (10, 'justtcg', 'justtcg', 'JustTCG', 'licensed', 'reference', 'USD', 'JustTCG'),
  (11, 'own_index', 'own', 'Own listing index', 'own', 'listings', 'USD', 'CardTrader, eBay, Mana Pool');

-- One row per sellable thing: foil, etched and each condition/language are
-- separate SKUs, never multipliers on a base price.
CREATE TABLE skus (
  id bigserial PRIMARY KEY,
  game text NOT NULL DEFAULT 'mtg' CHECK (game IN ('mtg')),
  printing_id uuid NOT NULL, -- Scryfall printing id for mtg
  finish text NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
  condition text NOT NULL DEFAULT 'NM' CHECK (condition IN ('NM', 'LP', 'MP', 'HP', 'DMG')),
  lang text NOT NULL DEFAULT 'en',
  mtgjson_uuid uuid,
  tcgplayer_sku_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game, printing_id, finish, condition, lang)
);
CREATE INDEX skus_mtgjson_uuid_idx ON skus (mtgjson_uuid) WHERE mtgjson_uuid IS NOT NULL;

-- Snapshot manifest. snapshot_id is 'YYYY-MM-DD.n'; seq orders every
-- snapshot ever taken for a game and is what price_daily rows point at.
CREATE TABLE price_snapshots (
  seq bigserial PRIMARY KEY,
  game text NOT NULL DEFAULT 'mtg',
  snapshot_id text NOT NULL CHECK (snapshot_id ~ '^\d{4}-\d{2}-\d{2}\.\d+$'),
  as_of date NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  sources_ok text[] NOT NULL DEFAULT '{}',
  sources_failed text[] NOT NULL DEFAULT '{}',
  row_counts jsonb NOT NULL DEFAULT '{}',
  -- ECB reference rate frozen at snapshot time so history is reproducible.
  -- Only reported, never used to blend currencies.
  fx_eur_usd numeric(12, 6),
  fx_as_of date,
  changelog text,
  UNIQUE (game, snapshot_id),
  UNIQUE (game, as_of, revision)
);

CREATE TABLE price_daily (
  sku_id bigint NOT NULL REFERENCES skus (id),
  as_of date NOT NULL,
  source_id smallint NOT NULL REFERENCES price_sources (id),
  snapshot_seq bigint NOT NULL REFERENCES price_snapshots (seq),
  retail_cents integer,
  buylist_cents integer,
  low_cents integer,
  trend_cents integer,
  market_cents integer,
  market_smooth_cents integer,
  mid_cents integer,
  listing_count integer,
  seller_count integer,
  method text CHECK (method IN ('sales', 'listings', 'reference', 'derived', 'carry_forward')),
  observed_at timestamptz,
  flags text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (sku_id, as_of, source_id, snapshot_seq)
) PARTITION BY RANGE (as_of);

CREATE FUNCTION ensure_price_partitions(from_month date, to_month date)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', from_month)::date;
  created integer := 0;
  part text;
BEGIN
  WHILE m <= date_trunc('month', to_month)::date LOOP
    part := 'price_daily_' || to_char(m, 'YYYY_MM');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF price_daily FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date
      );
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END;
$$;

SELECT ensure_price_partitions((current_date - interval '4 months')::date,
                               (current_date + interval '2 months')::date);

-- The hot read table: latest value per (sku, source) as of the newest
-- snapshot, plus change windows computed once by that snapshot.
CREATE TABLE price_current (
  sku_id bigint NOT NULL REFERENCES skus (id),
  source_id smallint NOT NULL REFERENCES price_sources (id),
  snapshot_seq bigint NOT NULL REFERENCES price_snapshots (seq),
  as_of date NOT NULL,
  retail_cents integer,
  buylist_cents integer,
  low_cents integer,
  trend_cents integer,
  market_cents integer,
  market_smooth_cents integer,
  mid_cents integer,
  listing_count integer,
  seller_count integer,
  method text,
  observed_at timestamptz,
  flags text[] NOT NULL DEFAULT '{}',
  change_1d numeric(10, 4),
  change_7d numeric(10, 4),
  change_30d numeric(10, 4),
  PRIMARY KEY (sku_id, source_id)
);
CREATE INDEX price_current_source_idx ON price_current (source_id);

ALTER TABLE ingest_runs
  ADD COLUMN game text,
  ADD COLUMN snapshot_id text;
