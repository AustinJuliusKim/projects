-- Search and filter indexes for the phase-2 API: full-text over
-- name/type_line/oracle_text, trigram for autocomplete/fuzzy lookup, GIN over
-- the array filter columns, btrees for common sorts and joins.

ALTER TABLE cards ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(name, '') || ' ' || coalesce(type_line, '') || ' ' || coalesce(oracle_text, '')
    )
  ) STORED;

CREATE INDEX cards_search_tsv_idx ON cards USING gin (search_tsv);
CREATE INDEX cards_name_trgm_idx ON cards USING gin (name gin_trgm_ops);
CREATE INDEX cards_name_lower_idx ON cards (lower(name));
CREATE INDEX cards_keywords_idx ON cards USING gin (keywords);
CREATE INDEX cards_color_identity_idx ON cards USING gin (color_identity);
CREATE INDEX cards_mana_value_idx ON cards (mana_value);
CREATE INDEX cards_edhrec_rank_idx ON cards (edhrec_rank);
CREATE INDEX printings_oracle_id_idx ON printings (oracle_id);
CREATE INDEX printings_set_code_idx ON printings (set_code);
