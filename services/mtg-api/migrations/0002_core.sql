-- Core card-data tables, fed exclusively by the Scryfall bulk ingest
-- (src/mtg_api/ingest/). One row per unique oracle card in `cards`; per-set
-- printings live in `printings`. Raw Scryfall JSON is deliberately not stored:
-- every column here is either served by the API or used for filtering, and the
-- bulk files can always be re-ingested.

CREATE TABLE sets (
  code text PRIMARY KEY,
  name text NOT NULL,
  set_type text,
  released_at date,
  card_count integer,
  icon_svg_uri text
);

CREATE TABLE cards (
  oracle_id uuid PRIMARY KEY,
  -- NOT unique: distinct oracle cards can share a name (e.g. Unfinity
  -- attractions like "The Superlatorium" have several variants, each with
  -- its own oracle_id).
  name text NOT NULL,
  mana_cost text,
  mana_value numeric,
  type_line text,
  oracle_text text,
  colors text[],
  color_identity text[],
  keywords text[],
  power text,
  toughness text,
  loyalty text,
  defense text,
  produced_mana text[],
  layout text,
  legalities jsonb,
  card_faces jsonb,
  reserved boolean NOT NULL DEFAULT false,
  edhrec_rank integer,
  -- Soft delete: cards absent from a bulk file are flagged, never dropped, so
  -- a truncated download can't destroy data (load.py also aborts on a large
  -- shrink before flagging anything).
  is_removed boolean NOT NULL DEFAULT false,
  -- sha256 over the canonical content fields; upserts skip rows whose hash is
  -- unchanged, and phase 3 re-embeds only when this changes.
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE printings (
  id uuid PRIMARY KEY, -- Scryfall card id
  oracle_id uuid NOT NULL REFERENCES cards (oracle_id) ON DELETE CASCADE,
  set_code text NOT NULL REFERENCES sets (code),
  collector_number text,
  rarity text,
  lang text,
  released_at date,
  artist text,
  finishes text[],
  promo boolean NOT NULL DEFAULT false,
  digital boolean NOT NULL DEFAULT false,
  image_small text,
  image_normal text,
  image_status text,
  -- Prices churn every bulk refresh, so they are excluded from content_hash
  -- and updated by a separate guarded statement in load.py.
  price_usd numeric,
  price_usd_foil numeric,
  price_eur numeric,
  price_tix numeric,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rulings (
  oracle_id uuid NOT NULL,
  published_at date,
  comment text NOT NULL,
  -- sha256 of the comment text; rulings have no Scryfall id of their own, so
  -- (oracle_id, comment_hash) is the identity. The table is truncate-and-
  -- reloaded each ingest run.
  comment_hash text NOT NULL,
  PRIMARY KEY (oracle_id, comment_hash)
);

-- One row per source per ingest run: the observability layer (alongside the
-- GitHub Actions job log/summary) and the updated_at gate that lets unchanged
-- bulk files be skipped.
CREATE TABLE ingest_runs (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  bulk_updated_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_inserted integer,
  rows_updated integer,
  rows_removed integer,
  status text NOT NULL DEFAULT 'running',
  error text
);
