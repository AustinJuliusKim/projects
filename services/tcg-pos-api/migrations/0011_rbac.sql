-- 0011_rbac: users, roles, permissions and store memberships, and the
-- database owning the "who did it" columns (docs/AUTH_PLAN.md, milestone A1).
--
-- Why it looks like this:
--   * The access token proves who (its `sub`); these tables decide what. The
--     API resolves the caller's membership on every request inside the same
--     RLS transaction (resolve_principal), so a disabled member or a role
--     change takes effect on the next request — no claim can go stale.
--   * app_user is global (a person can belong to several stores), keyed by
--     the identity provider's `sub`. Like search_outbox (0007) it is
--     owner-only: RLS ENABLEd with no policy and no grants, reached solely
--     through the SECURITY DEFINER functions below, and not FORCEd so the
--     owner needs no BYPASSRLS. email is lower-cased and NOT unique: two
--     sign-in methods for one address are two users until someone links
--     them deliberately (never auto-merge on email).
--   * permission is the fixed vocabulary (a test asserts it equals the
--     Python Perm enum). role is either a system role (tenant_id NULL,
--     is_system) shared by every store, or a store's own custom role (none
--     yet). role_permission maps roles to permissions.
--   * membership is (tenant, user) -> role, status active|disabled, and an
--     optional location scope (NULL = every location; used from Phase 5).
--     A trigger keeps a membership's role inside its own store (system or
--     same-tenant), another refuses to leave a store without an active
--     owner. The API also locks the owner rows before checking, so two
--     concurrent demotions can't both pass; the trigger is the backstop.
--   * invite stores only a SHA-256 of the one-time token; tcg_pos_app can't
--     even read that column. Revoking sets revoked_at (the app role has no
--     DELETE anywhere).
--   * Tenancy: every tenant table is RLS ENABLEd + FORCEd with the usual
--     tenant_isolation policy. The definer functions run as the owning
--     (migrating) role; where they must look across tenants (my_stores,
--     accept_invite) a SELECT-only policy scoped TO that role admits the
--     rows — the same owner-policy pattern as 0006/0008. Where they write
--     (create_store, accept_invite) they set app.tenant_id to the target
--     store for the duration and restore it, so the writes pass the normal
--     tenant policy.
--   * Actors: inventory_ledger.actor, credit_ledger.actor, audit_log.actor
--     and buylist.created_by now DEFAULT to the transaction's app.actor GUC
--     (set by the API from the verified principal: user:<uuid>, job:<name>,
--     storefront:<slug>, ...), and a BEFORE INSERT trigger rejects any other
--     value — or a missing app.actor — for rows written as tcg_pos_app. Route
--     code cannot forge who did something. approved_by (the manager whose
--     approval a write consumed, A3) works the same way from
--     app.approved_by. Rows written by definer functions (owner) are exempt;
--     those functions write their actor explicitly.
--   * Default approval-policy rows for the cashier role arrive with the
--     approval tables in 0012.

-- ---------------------------------------------------------------------------
-- users

CREATE TABLE app_user (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub  text NOT NULL UNIQUE CHECK (length(cognito_sub) BETWEEN 1 AND 200),
    email        text CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 254
                                               AND email = lower(email))),
    display_name text CHECK (length(display_name) BETWEEN 1 AND 100),
    created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_user FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- permissions and roles (seeded before RLS is enabled, so the seed needs no
-- policy even where the migrating role lacks BYPASSRLS)

CREATE TABLE permission (
    key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),
    description text NOT NULL
);

INSERT INTO permission (key, description) VALUES
    ('pos.sell', 'Ring up sales at the register'),
    ('pos.discount', 'Apply discounts to a sale'),
    ('pos.price_override', 'Override an item''s price on a sale'),
    ('pos.refund', 'Refund a sale'),
    ('pos.void', 'Void a sale or line'),
    ('pos.drawer_open', 'Open the cash drawer without a sale'),
    ('credit.read', 'See customers'' store credit'),
    ('credit.issue', 'Issue store credit'),
    ('credit.adjust', 'Correct a store-credit balance'),
    ('buylist.create', 'Create buylist offers'),
    ('buylist.payout_credit', 'Pay out a buylist in store credit'),
    ('buylist.payout_cash', 'Pay out a buylist in cash'),
    ('inventory.read', 'See inventory, prices and price suggestions'),
    ('inventory.adjust', 'Change inventory quantities'),
    ('inventory.price_edit', 'Set shelf prices'),
    ('pricing.rules_manage', 'Change the store''s pricing rule'),
    ('imports.run', 'Run inventory imports'),
    ('web_orders.read', 'See web orders'),
    ('web_orders.fulfill', 'Mark web orders picked up or cancel them'),
    ('storefront.manage', 'Manage the web storefront''s settings'),
    ('customers.read', 'See customers'),
    ('customers.manage', 'Create and edit customers'),
    ('reports.view', 'See reports'),
    ('audit.read', 'Read the audit log'),
    ('staff.manage', 'Invite, change and disable staff'),
    ('roles.manage', 'Create and edit custom roles'),
    ('registers.manage', 'Enroll and revoke register devices'),
    ('apikeys.manage', 'Create and revoke API keys'),
    ('channels.manage', 'Connect and configure sales channels'),
    ('settings.manage', 'Change store settings'),
    ('billing.manage', 'Manage the subscription and billing'),
    ('approve.override', 'Approve another staff member''s restricted action');

CREATE TABLE role (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid REFERENCES tenant (id),
    key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    is_system  boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (is_system = (tenant_id IS NULL)),
    -- A store's own role can't pose as a system role (escalation checks and
    -- resolve_principal identify the owner by key).
    CHECK (is_system OR key NOT IN ('owner', 'manager', 'buyer', 'cashier')),
    UNIQUE (tenant_id, key)
);

-- UNIQUE (tenant_id, key) treats NULLs as distinct; system keys need their own.
CREATE UNIQUE INDEX role_system_key ON role (key) WHERE tenant_id IS NULL;

CREATE TABLE role_permission (
    role_id uuid NOT NULL REFERENCES role (id),
    perm    text NOT NULL REFERENCES permission (key),
    PRIMARY KEY (role_id, perm)
);

INSERT INTO role (key, name, is_system) VALUES
    ('owner', 'Owner', true),
    ('manager', 'Manager', true),
    ('buyer', 'Buyer', true),
    ('cashier', 'Cashier', true);

-- owner: everything.
INSERT INTO role_permission (role_id, perm)
SELECT r.id, p.key FROM role r CROSS JOIN permission p
WHERE r.tenant_id IS NULL AND r.key = 'owner';

-- manager: everything except billing, roles, channels and API keys.
INSERT INTO role_permission (role_id, perm)
SELECT r.id, p.key FROM role r CROSS JOIN permission p
WHERE r.tenant_id IS NULL AND r.key = 'manager'
  AND p.key NOT IN ('billing.manage', 'roles.manage', 'channels.manage', 'apikeys.manage');

INSERT INTO role_permission (role_id, perm)
SELECT r.id, p.perm FROM role r CROSS JOIN (VALUES
    ('buylist.create'), ('buylist.payout_credit'), ('buylist.payout_cash'),
    ('inventory.read'), ('inventory.adjust'), ('inventory.price_edit'), ('imports.run'),
    ('credit.read'), ('credit.issue'), ('customers.read'), ('pos.sell')) AS p (perm)
WHERE r.tenant_id IS NULL AND r.key = 'buyer';

INSERT INTO role_permission (role_id, perm)
SELECT r.id, p.perm FROM role r CROSS JOIN (VALUES
    ('pos.sell'), ('pos.discount'), ('inventory.read'), ('credit.read'), ('customers.read'),
    ('web_orders.read'), ('web_orders.fulfill')) AS p (perm)
WHERE r.tenant_id IS NULL AND r.key = 'cashier';

-- ---------------------------------------------------------------------------
-- memberships and invites

CREATE TABLE membership (
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    user_id     uuid NOT NULL REFERENCES app_user (id),
    role_id     uuid NOT NULL REFERENCES role (id),
    location_id uuid,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    invited_by  uuid REFERENCES app_user (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);

CREATE INDEX membership_user_idx ON membership (user_id);

CREATE TABLE invite (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    email       text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
    role_id     uuid NOT NULL REFERENCES role (id),
    token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at  timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES app_user (id),
    revoked_at  timestamptz,
    invited_by  uuid NOT NULL REFERENCES app_user (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE INDEX invite_tenant_idx ON invite (tenant_id, created_at);

-- A membership or invite may only use a system role or its own store's role.
-- Runs as the invoker, so under RLS another store's roles are invisible too.
CREATE FUNCTION role_in_tenant_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.role r WHERE r.id = NEW.role_id
                   AND (r.tenant_id IS NULL OR r.tenant_id = NEW.tenant_id)) THEN
        RAISE EXCEPTION 'role % is not available to this store', NEW.role_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER membership_role_guard
    BEFORE INSERT OR UPDATE OF role_id, tenant_id ON membership
    FOR EACH ROW EXECUTE FUNCTION role_in_tenant_guard();
CREATE TRIGGER invite_role_guard
    BEFORE INSERT OR UPDATE OF role_id, tenant_id ON invite
    FOR EACH ROW EXECUTE FUNCTION role_in_tenant_guard();

-- A store always keeps at least one active owner.
CREATE FUNCTION membership_last_owner_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    owner_role uuid := (SELECT r.id FROM public.role r
                        WHERE r.tenant_id IS NULL AND r.key = 'owner');
BEGIN
    IF OLD.status = 'active' AND OLD.role_id = owner_role
       AND (NEW.status <> 'active' OR NEW.role_id <> owner_role)
       AND NOT EXISTS (SELECT 1 FROM public.membership m
                       WHERE m.tenant_id = OLD.tenant_id AND m.status = 'active'
                         AND m.role_id = owner_role) THEN
        RAISE EXCEPTION 'store % would have no active owner', OLD.tenant_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER membership_last_owner
    AFTER UPDATE OF status, role_id ON membership
    FOR EACH ROW EXECUTE FUNCTION membership_last_owner_guard();

-- ---------------------------------------------------------------------------
-- row-level security

ALTER TABLE permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON permission FOR SELECT USING (true);

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
CREATE POLICY system_or_tenant_read ON role FOR SELECT
    USING (tenant_id IS NULL OR tenant_id = (SELECT current_tenant_id()));

ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
-- Visible exactly when its role is (role's own policy applies in the subquery).
CREATE POLICY visible_role_read ON role_permission FOR SELECT
    USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id));

ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invite
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

-- Cross-tenant reads for the SECURITY DEFINER functions below (my_stores,
-- accept_invite), which run as this (the migrating) role.
DO $$
BEGIN
    EXECUTE format('CREATE POLICY definer_read ON role FOR SELECT TO %I USING (true)',
                   current_user);
    EXECUTE format('CREATE POLICY definer_read ON membership FOR SELECT TO %I USING (true)',
                   current_user);
    EXECUTE format('CREATE POLICY definer_read ON invite FOR SELECT TO %I USING (true)',
                   current_user);
    EXECUTE format('CREATE POLICY definer_read ON tenant FOR SELECT TO %I USING (true)',
                   current_user);
END
$$;

-- ---------------------------------------------------------------------------
-- the database owns the actor

CREATE FUNCTION enforce_actor() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    row_json jsonb := to_jsonb(NEW);
    expected text := nullif(current_setting('app.actor', true), '');
BEGIN
    IF current_user = 'tcg_pos_app' THEN
        IF expected IS NULL OR (row_json ->> TG_ARGV[0]) IS DISTINCT FROM expected THEN
            RAISE EXCEPTION '%.% must be the request''s actor', TG_TABLE_NAME, TG_ARGV[0]
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF TG_NARGS > 1 AND (row_json ->> TG_ARGV[1])::uuid IS DISTINCT FROM
                nullif(current_setting('app.approved_by', true), '')::uuid THEN
            RAISE EXCEPTION '%.% must be the request''s approver', TG_TABLE_NAME, TG_ARGV[1]
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

ALTER TABLE inventory_ledger
    ALTER COLUMN actor SET DEFAULT nullif(current_setting('app.actor', true), ''),
    ADD COLUMN approved_by uuid REFERENCES app_user (id)
        DEFAULT nullif(current_setting('app.approved_by', true), '')::uuid;
ALTER TABLE credit_ledger
    ALTER COLUMN actor SET DEFAULT nullif(current_setting('app.actor', true), ''),
    ADD COLUMN approved_by uuid REFERENCES app_user (id)
        DEFAULT nullif(current_setting('app.approved_by', true), '')::uuid;
ALTER TABLE audit_log
    ALTER COLUMN actor SET DEFAULT nullif(current_setting('app.actor', true), ''),
    ADD COLUMN approved_by uuid REFERENCES app_user (id)
        DEFAULT nullif(current_setting('app.approved_by', true), '')::uuid;
ALTER TABLE buylist
    ALTER COLUMN created_by SET DEFAULT nullif(current_setting('app.actor', true), '');

CREATE TRIGGER inventory_ledger_actor
    BEFORE INSERT ON inventory_ledger
    FOR EACH ROW EXECUTE FUNCTION enforce_actor('actor', 'approved_by');
CREATE TRIGGER credit_ledger_actor
    BEFORE INSERT ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION enforce_actor('actor', 'approved_by');
CREATE TRIGGER audit_log_actor
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION enforce_actor('actor', 'approved_by');
CREATE TRIGGER buylist_actor
    BEFORE INSERT ON buylist
    FOR EACH ROW EXECUTE FUNCTION enforce_actor('created_by');

-- ---------------------------------------------------------------------------
-- functions (SECURITY DEFINER: they run as the owner, see the header)

-- The caller's active membership in p_tenant, or no row.
CREATE FUNCTION resolve_principal(p_sub text, p_tenant uuid)
RETURNS TABLE (user_id uuid, role_key text, perms text[], location_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.id, r.key,
           ARRAY(SELECT rp.perm FROM public.role_permission rp
                 WHERE rp.role_id = r.id ORDER BY rp.perm),
           CASE WHEN m.location_id IS NULL THEN NULL ELSE ARRAY[m.location_id] END
    FROM public.app_user u
    JOIN public.membership m ON m.user_id = u.id
    JOIN public.role r ON r.id = m.role_id
    WHERE u.cognito_sub = p_sub AND m.tenant_id = p_tenant AND m.status = 'active'
$$;

-- Find or create the user for an identity-provider subject. A non-empty
-- p_email (from a verified token / userinfo) replaces the stored one.
CREATE FUNCTION ensure_app_user(p_sub text, p_email text)
RETURNS TABLE (id uuid, email text, display_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_email text := lower(nullif(btrim(p_email), ''));
BEGIN
    INSERT INTO public.app_user AS u (cognito_sub, email) VALUES (p_sub, v_email)
    ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email
        WHERE EXCLUDED.email IS NOT NULL AND u.email IS DISTINCT FROM EXCLUDED.email;
    RETURN QUERY
        SELECT u.id, u.email, u.display_name FROM public.app_user u WHERE u.cognito_sub = p_sub;
END
$$;

-- The stores the caller is an active member of.
CREATE FUNCTION my_stores(p_sub text)
RETURNS TABLE (tenant_id uuid, name text, role_key text, role_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT t.id, t.name, r.key, r.name
    FROM public.app_user u
    JOIN public.membership m ON m.user_id = u.id AND m.status = 'active'
    JOIN public.tenant t ON t.id = m.tenant_id
    JOIN public.role r ON r.id = m.role_id
    WHERE u.cognito_sub = p_sub
    ORDER BY t.name, t.id
$$;

-- Onboarding: a new store, its first location and the caller as its owner,
-- in the caller's transaction.
CREATE FUNCTION create_store(p_sub text, p_email text, p_name text,
                             p_location_name text DEFAULT 'Main')
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user uuid;
    v_tenant uuid := gen_random_uuid();
    v_prev text := current_setting('app.tenant_id', true);
BEGIN
    IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 100
       OR length(btrim(coalesce(p_location_name, ''))) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'store and location names must be 1-100 characters'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT u.id INTO v_user FROM public.ensure_app_user(p_sub, p_email) u;
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    INSERT INTO public.tenant (id, name) VALUES (v_tenant, btrim(p_name));
    INSERT INTO public.location (tenant_id, name) VALUES (v_tenant, btrim(p_location_name));
    INSERT INTO public.membership (tenant_id, user_id, role_id)
    SELECT v_tenant, v_user, r.id FROM public.role r WHERE r.tenant_id IS NULL AND r.key = 'owner';
    INSERT INTO public.audit_log (tenant_id, actor, action, entity, entity_id, after)
    VALUES (v_tenant, 'user:' || v_user, 'store.create', 'tenant', v_tenant,
            jsonb_build_object('name', btrim(p_name), 'owner', v_user));
    PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
    RETURN v_tenant;
END
$$;

-- Accept an invite by its token's hash. The invite's email must equal the
-- caller's stored email (set from a verified token, never from the client).
-- status: accepted | not_found | email_mismatch | revoked | used | expired |
-- already_member.
CREATE FUNCTION accept_invite(p_sub text, p_token_hash text)
RETURNS TABLE (status text, tenant_id uuid, role_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_user public.app_user;
    v_inv public.invite;
    v_member public.membership;
    v_role text;
    v_status text;
    v_prev text := current_setting('app.tenant_id', true);
BEGIN
    SELECT * INTO v_user FROM public.app_user u WHERE u.cognito_sub = p_sub;
    SELECT * INTO v_inv FROM public.invite i WHERE i.token_hash = p_token_hash;
    IF v_user.id IS NULL OR v_inv.id IS NULL THEN
        RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
        RETURN;
    END IF;
    IF v_user.email IS NULL OR v_user.email <> v_inv.email THEN
        RETURN QUERY SELECT 'email_mismatch'::text, NULL::uuid, NULL::text;
        RETURN;
    END IF;
    -- From here on the store's own tenant policy admits the writes.
    PERFORM set_config('app.tenant_id', v_inv.tenant_id::text, true);
    SELECT * INTO v_inv FROM public.invite i WHERE i.id = v_inv.id FOR UPDATE;
    SELECT r.key INTO v_role FROM public.role r WHERE r.id = v_inv.role_id;
    v_status := CASE
        WHEN v_inv.revoked_at IS NOT NULL THEN 'revoked'
        WHEN v_inv.accepted_at IS NOT NULL THEN 'used'
        WHEN v_inv.expires_at <= now() THEN 'expired'
    END;
    IF v_status IS NULL THEN
        SELECT * INTO v_member FROM public.membership m
        WHERE m.tenant_id = v_inv.tenant_id AND m.user_id = v_user.id FOR UPDATE;
        IF v_member.status = 'active' THEN
            v_status := 'already_member';
        END IF;
    END IF;
    IF v_status IS NULL THEN
        INSERT INTO public.membership AS m (tenant_id, user_id, role_id, invited_by)
        VALUES (v_inv.tenant_id, v_user.id, v_inv.role_id, v_inv.invited_by)
        ON CONFLICT ON CONSTRAINT membership_pkey DO UPDATE
            SET role_id = EXCLUDED.role_id, status = 'active', location_id = NULL,
                invited_by = EXCLUDED.invited_by, updated_at = now();
        UPDATE public.invite i SET accepted_at = now(), accepted_by = v_user.id
        WHERE i.id = v_inv.id;
        INSERT INTO public.audit_log (tenant_id, actor, action, entity, entity_id, before, after)
        VALUES (v_inv.tenant_id, 'user:' || v_user.id, 'invite.accept', 'membership', v_user.id,
                CASE WHEN v_member.user_id IS NULL THEN NULL
                     ELSE jsonb_build_object('status', v_member.status) END,
                jsonb_build_object('invite_id', v_inv.id, 'role', v_role, 'status', 'active'));
        v_status := 'accepted';
    END IF;
    PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
    RETURN QUERY SELECT v_status, v_inv.tenant_id, v_role;
END
$$;

-- The current store's members with their names (app_user is owner-only).
CREATE FUNCTION tenant_staff()
RETURNS TABLE (user_id uuid, email text, display_name text, role_key text, role_name text,
               status text, location_id uuid, invited_by uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT m.user_id, u.email, u.display_name, r.key, r.name, m.status, m.location_id,
           m.invited_by, m.created_at
    FROM public.membership m
    JOIN public.app_user u ON u.id = m.user_id
    JOIN public.role r ON r.id = m.role_id
    WHERE m.tenant_id = public.current_tenant_id()
    ORDER BY m.status, u.email, m.user_id
$$;

REVOKE EXECUTE ON FUNCTION role_in_tenant_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION membership_last_owner_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enforce_actor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_principal(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_app_user(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION my_stores(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_store(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION accept_invite(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tenant_staff() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_principal(text, uuid) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION ensure_app_user(text, text) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION my_stores(text) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION create_store(text, text, text, text) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION accept_invite(text, text) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION tenant_staff() TO tcg_pos_app;

-- ---------------------------------------------------------------------------
-- app-role grants (no DELETE; no access to app_user or invite.token_hash)

GRANT SELECT ON permission, role, role_permission TO tcg_pos_app;
GRANT SELECT ON membership TO tcg_pos_app;
GRANT UPDATE (role_id, status, location_id, updated_at) ON membership TO tcg_pos_app;
GRANT SELECT (id, tenant_id, email, role_id, expires_at, accepted_at, accepted_by, revoked_at,
              invited_by, created_at) ON invite TO tcg_pos_app;
GRANT INSERT (email, role_id, token_hash, expires_at, invited_by) ON invite TO tcg_pos_app;
GRANT UPDATE (revoked_at) ON invite TO tcg_pos_app;
