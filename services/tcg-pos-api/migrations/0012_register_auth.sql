-- 0012_register_auth: register devices, staff PINs, register sessions and
-- manager approvals (docs/AUTH_PLAN.md, milestone A3).
--
-- Why it looks like this:
--   * A register is a shared machine. It is enrolled once by someone with
--     registers.manage, which yields a long random device secret (shown
--     once; only its SHA-256 is stored). Staff then sign in on that device
--     with a 6-digit PIN and get a short-lived register session. Requests
--     carry both (`Authorization: Device <secret>` + `X-Register-Session`),
--     and the principal is the session's user, acting through the device
--     (actor device:<id>/user:<id>). A PIN alone is worth nothing off an
--     enrolled, unrevoked device.
--   * Secrets and session tokens are 256-bit random values, so a plain
--     SHA-256 is the right lookup key (no salt/stretching needed). PINs are
--     low-entropy and get Argon2id in the API (argon2-cffi), plus a lockout
--     (fail_count/locked_until) and a per-device rate limit.
--   * Device and session lookups happen before the store is known (the
--     device secret determines it), so they go through the SECURITY DEFINER
--     resolve_register(), reading via owner-scoped definer_read policies
--     (the 0011 pattern). The app role can't read secret_hash/token_hash at
--     all. Everything after that (last_seen_at, sign-out, revocation) is
--     ordinary tenant-scoped SQL as tcg_pos_app.
--   * Revoking a device is instant: resolve_register() only returns
--     unrevoked devices, and the API ends the device's sessions as well.
--     Sessions expire 12 h after sign-in or after 30 min without a request.
--   * approval_policy refines a role's permission per action: deny (never),
--     approval (a manager must approve, except at or under limit_cents) or
--     allow (directly, up to limit_cents; above it, approval). No row = the
--     role's plain permission decides. Rows with tenant_id NULL are the
--     defaults for system roles (seeded below for cashier); a store's own
--     row for the same role and permission wins over the default. There is
--     no API to edit policies yet — when there is, it must apply the same
--     grantability rules as roles (a policy row can let a role act on a
--     permission it doesn't hold).
--   * approval is a one-shot token: a manager enters their PIN on the
--     register for one specific request (perm + payload hash + amount),
--     valid 60 s, consumed atomically by the retried request, which then
--     writes approved_by on its ledger/audit rows (0011's app.approved_by).
--   * Who-did-it columns the API must not choose (enrolled_by,
--     requested_by) default from the transaction's app.user_id and aren't
--     insertable by the app role.

-- ---------------------------------------------------------------------------
-- tables

CREATE TABLE register_device (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    register_id  uuid NOT NULL REFERENCES register (id),
    secret_hash  text NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    enrolled_by  uuid NOT NULL REFERENCES app_user (id)
                 DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
    enrolled_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at   timestamptz,
    UNIQUE (tenant_id, id)
);

CREATE INDEX register_device_tenant_idx ON register_device (tenant_id, enrolled_at);

-- A device may only be enrolled for a register of its own store.
CREATE FUNCTION register_device_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.register r
                   WHERE r.id = NEW.register_id AND r.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'register % is not in this store', NEW.register_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER register_device_register_guard
    BEFORE INSERT OR UPDATE OF register_id, tenant_id ON register_device
    FOR EACH ROW EXECUTE FUNCTION register_device_guard();

CREATE TABLE staff_pin (
    tenant_id    uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    user_id      uuid NOT NULL REFERENCES app_user (id),
    pin_hash     text NOT NULL CHECK (pin_hash LIKE '$argon2id$%'),
    fail_count   integer NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
    locked_until timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id)
);

CREATE TABLE register_session (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    device_id    uuid NOT NULL,
    user_id      uuid NOT NULL REFERENCES app_user (id),
    token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    FOREIGN KEY (tenant_id, device_id) REFERENCES register_device (tenant_id, id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES membership (tenant_id, user_id)
);

CREATE INDEX register_session_device_idx ON register_session (tenant_id, device_id)
    WHERE ended_at IS NULL;

CREATE TABLE approval_policy (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid REFERENCES tenant (id),
    role_id     uuid NOT NULL REFERENCES role (id),
    perm        text NOT NULL REFERENCES permission (key),
    mode        text NOT NULL CHECK (mode IN ('allow', 'approval', 'deny')),
    limit_cents integer CHECK (limit_cents >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (mode <> 'deny' OR limit_cents IS NULL)
);

-- One row per (store or default, role, permission).
CREATE UNIQUE INDEX approval_policy_default_key ON approval_policy (role_id, perm)
    WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX approval_policy_tenant_key ON approval_policy (tenant_id, role_id, perm)
    WHERE tenant_id IS NOT NULL;

CREATE TABLE approval (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    perm         text NOT NULL REFERENCES permission (key),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    amount_cents bigint CHECK (amount_cents >= 0),
    requested_by uuid NOT NULL REFERENCES app_user (id)
                 DEFAULT nullif(current_setting('app.user_id', true), '')::uuid,
    approved_by  uuid NOT NULL REFERENCES app_user (id),
    device_id    uuid NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz,
    CHECK (approved_by <> requested_by),
    FOREIGN KEY (tenant_id, device_id) REFERENCES register_device (tenant_id, id)
);

CREATE INDEX approval_tenant_idx ON approval (tenant_id, created_at);

-- Defaults for system roles: a cashier needs a manager for refunds, voids,
-- store-credit corrections and price overrides.
INSERT INTO approval_policy (tenant_id, role_id, perm, mode)
SELECT NULL, r.id, p.perm, 'approval' FROM role r CROSS JOIN (VALUES
    ('pos.refund'), ('pos.void'), ('credit.adjust'), ('pos.price_override')) AS p (perm)
WHERE r.tenant_id IS NULL AND r.key = 'cashier';

-- ---------------------------------------------------------------------------
-- row-level security

ALTER TABLE register_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_device FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON register_device
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE staff_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_pin FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_pin
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE register_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON register_session
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE approval_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY default_or_tenant_read ON approval_policy FOR SELECT
    USING (tenant_id IS NULL OR tenant_id = (SELECT current_tenant_id()));

ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

-- Cross-tenant reads for resolve_register(), which runs as this role.
DO $$
BEGIN
    EXECUTE format('CREATE POLICY definer_read ON register_device FOR SELECT TO %I USING (true)',
                   current_user);
    EXECUTE format('CREATE POLICY definer_read ON register_session FOR SELECT TO %I USING (true)',
                   current_user);
END
$$;

-- ---------------------------------------------------------------------------
-- functions

-- The unrevoked device with this secret hash and, when p_session_hash is
-- given, that device's session. No row = unknown or revoked device.
-- session_status: ok | none (no session given) | invalid | ended | expired
-- | idle. Reads only; the API bumps last_seen_at as tcg_pos_app.
CREATE FUNCTION resolve_register(p_secret_hash text, p_session_hash text,
                                 p_idle_seconds integer DEFAULT 1800)
RETURNS TABLE (device_id uuid, tenant_id uuid, register_id uuid, session_id uuid,
               user_id uuid, session_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_dev public.register_device;
    v_ses public.register_session;
BEGIN
    SELECT * INTO v_dev FROM public.register_device d
    WHERE d.secret_hash = p_secret_hash AND d.revoked_at IS NULL;
    IF v_dev.id IS NULL THEN
        RETURN;
    END IF;
    IF p_session_hash IS NULL THEN
        RETURN QUERY SELECT v_dev.id, v_dev.tenant_id, v_dev.register_id, NULL::uuid, NULL::uuid,
                            'none'::text;
        RETURN;
    END IF;
    SELECT * INTO v_ses FROM public.register_session s
    WHERE s.token_hash = p_session_hash AND s.device_id = v_dev.id;
    RETURN QUERY SELECT v_dev.id, v_dev.tenant_id, v_dev.register_id, v_ses.id, v_ses.user_id,
        CASE
            WHEN v_ses.id IS NULL THEN 'invalid'
            WHEN v_ses.ended_at IS NOT NULL THEN 'ended'
            WHEN v_ses.expires_at <= now() THEN 'expired'
            WHEN v_ses.last_seen_at <= now() - make_interval(secs => p_idle_seconds) THEN 'idle'
            ELSE 'ok'
        END;
END
$$;

REVOKE EXECUTE ON FUNCTION register_device_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_register(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_register(text, text, integer) TO tcg_pos_app;

-- ---------------------------------------------------------------------------
-- app-role grants (no DELETE; no access to secret_hash / token_hash)

GRANT SELECT (id, tenant_id, register_id, enrolled_by, enrolled_at, last_seen_at, revoked_at)
    ON register_device TO tcg_pos_app;
GRANT INSERT (register_id, secret_hash) ON register_device TO tcg_pos_app;
GRANT UPDATE (last_seen_at, revoked_at) ON register_device TO tcg_pos_app;

GRANT SELECT, INSERT (user_id, pin_hash), UPDATE (pin_hash, fail_count, locked_until, updated_at)
    ON staff_pin TO tcg_pos_app;

GRANT SELECT (id, tenant_id, device_id, user_id, created_at, expires_at, last_seen_at, ended_at)
    ON register_session TO tcg_pos_app;
GRANT INSERT (device_id, user_id, token_hash, expires_at) ON register_session TO tcg_pos_app;
GRANT UPDATE (last_seen_at, ended_at) ON register_session TO tcg_pos_app;

GRANT SELECT ON approval_policy TO tcg_pos_app;

GRANT SELECT ON approval TO tcg_pos_app;
GRANT INSERT (perm, payload_hash, amount_cents, approved_by, device_id, expires_at)
    ON approval TO tcg_pos_app;
GRANT UPDATE (consumed_at) ON approval TO tcg_pos_app;
