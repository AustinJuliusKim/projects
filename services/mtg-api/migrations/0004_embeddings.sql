-- Card-text embeddings for the similarity engine (phase 3). One row per live
-- oracle card; embed_hash (sha256 of the canonical embed text + model id)
-- lets the weekly embed step re-embed only cards whose oracle text changed.
-- halfvec(512) halves storage vs vector: ~36MB data for 35k cards.
--
-- If the HNSW build ever exceeds the database's maintenance_work_mem (not
-- expected at 35k rows), fall back to:
--   CREATE INDEX card_embeddings_embedding_idx ON card_embeddings
--     USING ivfflat (embedding halfvec_cosine_ops) WITH (lists = 200);

CREATE TABLE card_embeddings (
  oracle_id uuid PRIMARY KEY REFERENCES cards (oracle_id) ON DELETE CASCADE,
  embedding halfvec(512) NOT NULL,
  model text NOT NULL,
  embed_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX card_embeddings_embedding_idx ON card_embeddings
  USING hnsw (embedding halfvec_cosine_ops);
