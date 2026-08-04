-- Extensions: pgcrypto for gen_random_uuid, pg_trgm for fuzzy name matching,
-- vector (pgvector) for card-similarity embeddings (used from phase 3).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
