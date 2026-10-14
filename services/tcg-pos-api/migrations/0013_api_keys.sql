-- 0013_api_keys: store-scoped API keys for integrations and scripts
-- (docs/AUTH_PLAN.md, milestone A4).
--
-- Why it looks like this:
--   * A key is `tcgpos_<prefix>_<secret>`: a 12-hex-char public prefix to
--     find the row and a 256-bit secret, of which only the SHA-256 is
--     stored (a random secret needs no stretching). The API compares the
--     hash in constant time.
--   * A key belongs to one store and carries its own permission list, which
--     at creation must be a subset of its creator's permissions and may not
--     include the identity/admin permissions (staff, roles, registers, API
--     keys, approvals, billing) — the API enforces both. Keys act as
--     apikey:<id>, have no user and no role, and so no approval policy
--     applies to them.
--   * Revocation is instant: resolve_api_key() only returns unrevoked keys,
--     and keys are looked up on every request. Keys don't expire; revoke
--     them when the integration (or the person who set it up) goes away.
--   * The lookup happens before the store is known (the key decides it), so
--     it is a SECURITY DEFINER function reading through an owner-scoped
--     definer_read policy (the 0011 pattern); the app role can't read
--     secret_hash. created_by defaults from app.user_id and isn't insertable.

CREATE TABLE api_key (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{12}$'),
    secret_hash  text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    perms        text[] NOT NULL CHECK (cardinality(perms) BETWEEN 1 AND 64),
    created_by   uuid NOT NULL REFERENCES app_user (id)
                 DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);

CREATE INDEX api_key_tenant_idx ON api_key (tenant_id, created_at);

-- Every listed permission must exist (arrays can't carry a foreign key).
CREATE FUNCTION api_key_perms_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM unnest(NEW.perms) p (key)
               WHERE NOT EXISTS (SELECT 1 FROM public.permission x WHERE x.key = p.key)) THEN
        RAISE EXCEPTION 'api_key.perms has an unknown permission'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER api_key_perms
    BEFORE INSERT OR UPDATE OF perms ON api_key
    FOR EACH ROW EXECUTE FUNCTION api_key_perms_guard();

ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

DO $$
BEGIN
    EXECUTE format('CREATE POLICY definer_read ON api_key FOR SELECT TO %I USING (true)',
                   current_user);
END
$$;

-- The unrevoked key with this prefix (the API checks the secret), or no row.
CREATE FUNCTION resolve_api_key(p_prefix text)
RETURNS TABLE (id uuid, tenant_id uuid, secret_hash text, perms text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT k.id, k.tenant_id, k.secret_hash, k.perms FROM public.api_key k
    WHERE k.prefix = p_prefix AND k.revoked_at IS NULL
$$;

REVOKE EXECUTE ON FUNCTION api_key_perms_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO tcg_pos_app;

GRANT SELECT (id, tenant_id, name, prefix, perms, created_by, created_at, last_used_at,
              revoked_at) ON api_key TO tcg_pos_app;
GRANT INSERT (name, prefix, secret_hash, perms) ON api_key TO tcg_pos_app;
GRANT UPDATE (last_used_at, revoked_at) ON api_key TO tcg_pos_app;
