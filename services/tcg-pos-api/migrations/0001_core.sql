-- 0001_core: tenancy, inventory, and the two append-only logs.
--
-- Why it looks like this:
--   * Every store's rows live in the same tables, separated by tenant_id and
--     Postgres row-level security. RLS is ENABLEd *and* FORCEd so even the
--     table owner is filtered; only superusers / BYPASSRLS roles (migrations,
--     admin) see across tenants.
--   * The tenant comes from the transaction-local GUC app.tenant_id, which
--     the API sets per request (deps.get_conn). current_tenant_id() returns
--     NULL when it is unset or empty, so an unscoped connection sees no rows
--     and cannot write any, instead of erroring or leaking.
--   * The API drops to the NOLOGIN role tcg_pos_app for every request (SET
--     LOCAL ROLE). That role gets only the grants it needs: no DELETE
--     anywhere, and only SELECT/INSERT on the ledger and audit tables.
--   * Child rows reference parents by (tenant_id, id) composite FKs, so a row
--     can never point at another tenant's location / item even though FK
--     checks themselves ignore RLS.
--   * inventory_item.printing_id is the Scryfall printing id from the catalog
--     (services/mtg-api, a different database) — deliberately no FK.
--   * Money is integer cents. price_cents NULL means "not priced yet", never 0.
--   * inventory_ledger and audit_log are append-only: triggers reject UPDATE,
--     DELETE and TRUNCATE for every role, including the owner. Corrections
--     are new rows.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tcg_pos_app') THEN
        CREATE ROLE tcg_pos_app NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tcg_pos_app;

CREATE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END
$$;

-- ---------------------------------------------------------------------------
-- tenant / location / register

CREATE TABLE tenant (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE location (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE register (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id(),
    location_id uuid NOT NULL,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- inventory

CREATE TABLE inventory_item (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id(),
    location_id uuid NOT NULL,
    printing_id uuid NOT NULL,
    game        text NOT NULL DEFAULT 'mtg',
    condition   text NOT NULL CHECK (condition IN ('NM', 'LP', 'MP', 'HP', 'DMG')),
    finish      text NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
    lang        text NOT NULL DEFAULT 'en',
    qty         integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
    price_cents integer CHECK (price_cents >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
    UNIQUE (tenant_id, id),
    -- The grain: one row per store × location × printing × condition × finish × language.
    CONSTRAINT inventory_item_grain
        UNIQUE (tenant_id, location_id, printing_id, condition, finish, lang)
);

CREATE INDEX inventory_item_printing_idx ON inventory_item (tenant_id, printing_id);

CREATE TABLE inventory_ledger (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL DEFAULT current_tenant_id(),
    inventory_item_id uuid NOT NULL,
    delta             integer NOT NULL CHECK (delta <> 0),
    reason            text NOT NULL,
    channel           text NOT NULL CHECK (channel IN (
                          'pos', 'web', 'ebay', 'manapool', 'cardtrader', 'tcgplayer',
                          'adjustment')),
    actor             text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_item (tenant_id, id)
);

CREATE INDEX inventory_ledger_item_idx ON inventory_ledger (tenant_id, inventory_item_id, created_at);

-- ---------------------------------------------------------------------------
-- audit log: who changed what, as before/after snapshots.

CREATE TABLE audit_log (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    actor     text NOT NULL,
    action    text NOT NULL,
    entity    text NOT NULL,
    entity_id uuid,
    before    jsonb,
    after     jsonb,
    at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity, entity_id, at);

-- ---------------------------------------------------------------------------
-- append-only enforcement

CREATE TRIGGER inventory_ledger_append_only
    BEFORE UPDATE OR DELETE ON inventory_ledger
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER inventory_ledger_no_truncate
    BEFORE TRUNCATE ON inventory_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- row-level security

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant
    USING (id = (SELECT current_tenant_id()))
    WITH CHECK (id = (SELECT current_tenant_id()));

ALTER TABLE location ENABLE ROW LEVEL SECURITY;
ALTER TABLE location FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON location
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE register ENABLE ROW LEVEL SECURITY;
ALTER TABLE register FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON register
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE inventory_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_item
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE inventory_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_ledger
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

-- ---------------------------------------------------------------------------
-- app-role grants (no DELETE anywhere; ledger/audit are insert-only)

GRANT EXECUTE ON FUNCTION current_tenant_id() TO tcg_pos_app;
GRANT SELECT ON tenant TO tcg_pos_app;
GRANT SELECT, INSERT, UPDATE ON location, register, inventory_item TO tcg_pos_app;
GRANT SELECT, INSERT ON inventory_ledger, audit_log TO tcg_pos_app;
