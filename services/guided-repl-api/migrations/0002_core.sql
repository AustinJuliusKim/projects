-- Core tables: users (our own PK; the auth provider's UID is just a column),
-- pre-account leads, owner-discriminated progress, proof-gate events, and
-- httpOnly-cookie sessions.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid uuid UNIQUE,
  email citext UNIQUE NOT NULL,
  name text,
  marketing_consent boolean NOT NULL DEFAULT false,
  stripe_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anon_id uuid NOT NULL,
  name text,
  email citext,
  consent boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  claimed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_anon_id_idx ON leads (anon_id);
CREATE INDEX leads_email_idx ON leads (email);

CREATE TABLE progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('anon', 'user')),
  owner_id uuid NOT NULL,
  lesson_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed')),
  assertions jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, lesson_id)
);

CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('anon', 'user')),
  owner_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_owner_idx ON events (owner_type, owner_id);
CREATE INDEX events_kind_idx ON events (kind);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
