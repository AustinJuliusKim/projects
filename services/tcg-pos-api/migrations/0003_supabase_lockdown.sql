-- 0003_supabase_lockdown: keep Supabase's Data API roles out of the schema.
--
-- Why it looks like this:
--   * Supabase exposes the `public` schema through PostgREST as the `anon` and
--     `authenticated` roles, and its default privileges grant those roles ALL
--     on every new table, sequence and function. RLS still filters tenant
--     tables (no policy admits a NULL app.tenant_id), but `schema_migrations`
--     had no RLS, the functions were callable, and "RLS is the only wall" is
--     one bad policy away from a leak. The POS is only ever reached through
--     the API (which drops to tcg_pos_app), so those roles get nothing.
--   * The revokes are guarded on the roles existing, so this is a no-op on
--     local / CI Postgres where they don't. Default privileges are revoked
--     too (for the migrating role, i.e. whoever owns these objects), so
--     tables added by later migrations don't silently re-grant them.
--   * EXECUTE on functions is granted to PUBLIC by Postgres itself, and anon
--     inherits PUBLIC, so that is revoked from PUBLIC as well; tcg_pos_app
--     keeps its explicit grant on current_tenant_id(). Trigger functions
--     don't need EXECUTE to fire.
--   * schema_migrations (created by scripts/migrate.py) gets RLS ENABLEd with
--     no policy, so any non-owner sees and writes nothing. It is deliberately
--     not FORCEd: the migrating role owns it and must keep reading and
--     inserting it, and on Supabase that role may not have BYPASSRLS.
--   * Also: disable the Data API for the POS Supabase project (OPS.md) — this
--     migration is the second wall, not the first.

DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
            EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
        END IF;
    END LOOP;
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO tcg_pos_app;

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE schema_migrations FROM PUBLIC;
