-- 0006_storefront: one public web storefront per store, the slug lookup the
-- public API resolves tenants with, and the single holdback rule.
--
-- Why it looks like this:
--   * One row per tenant (tenant_id is the primary key), like price_rule. No
--     row means "no storefront". The slug is globally unique because it is
--     the public URL (/s/<slug>); custom_domain is a placeholder for later.
--   * location_id is the one location whose stock the web sells and where
--     pickups happen (composite FK, so it is always the tenant's own).
--   * Holdback keeps copies off the web so the counter never sells the last
--     one twice: web_available(qty, copies, pct) =
--         greatest(0, qty - greatest(copies, ceil(qty * pct / 100)))
--     It is the ONLY place that rule lives: the order path, the cart quote
--     and the listings indexer all call it. qty is widened to numeric first
--     so qty * pct can't overflow integer.
--   * Public requests carry no tenant. storefront_by_slug() is SECURITY
--     DEFINER so it can find the tenant for a slug before app.tenant_id is
--     set; it returns only published rows and only the columns the public
--     side needs (never custom_domain, timestamps or the published flag).
--     published_storefronts() is the same shape for rebuild jobs.
--   * Both functions run as the table owner (the migrating role), and RLS is
--     FORCEd here like every tenant table, so the owner would see nothing
--     without app.tenant_id. Rather than depend on the owner having
--     BYPASSRLS (it may not on Supabase — see 0003), a SELECT-only policy
--     scoped TO the migrating role admits published rows. The API never
--     runs as that role (it always drops to tcg_pos_app), so request
--     traffic is still bound by the tenant policy alone.
--   * tcg_pos_worker is a NOLOGIN role for background jobs (listings
--     indexer, reservation expiry). The job's login role is granted it and
--     tcg_pos_app; it does cross-tenant bookkeeping only through SECURITY
--     DEFINER functions and reads tenant data as tcg_pos_app per tenant.
--   * 0003 revoked EXECUTE from PUBLIC (including default privileges), so
--     every function here is granted explicitly, and revoked from PUBLIC
--     again in case this runs as a role whose defaults weren't changed.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tcg_pos_worker') THEN
        CREATE ROLE tcg_pos_worker NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tcg_pos_worker;

CREATE TABLE storefront (
    tenant_id         uuid PRIMARY KEY DEFAULT current_tenant_id() REFERENCES tenant (id),
    slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
    display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
    published         boolean NOT NULL DEFAULT false,
    location_id       uuid NOT NULL,
    holdback_copies   integer NOT NULL DEFAULT 0 CHECK (holdback_copies >= 0),
    holdback_pct      integer NOT NULL DEFAULT 0 CHECK (holdback_pct BETWEEN 0 AND 100),
    reservation_hours integer NOT NULL DEFAULT 48 CHECK (reservation_hours BETWEEN 1 AND 336),
    custom_domain     text UNIQUE
                      CHECK (custom_domain IS NULL OR custom_domain ~ '^[a-z0-9.-]{3,253}$'),
    policy_text       text CHECK (length(policy_text) <= 4000),
    pickup_text       text CHECK (length(pickup_text) <= 1000),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);

ALTER TABLE storefront ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON storefront
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

-- The SECURITY DEFINER lookups below run as this (the migrating) role.
DO $$
BEGIN
    EXECUTE format(
        'CREATE POLICY definer_published_read ON storefront FOR SELECT TO %I USING (published)',
        current_user);
END
$$;

GRANT SELECT, INSERT, UPDATE ON storefront TO tcg_pos_app;

-- ---------------------------------------------------------------------------
-- functions

CREATE FUNCTION web_available(qty integer, copies integer, pct integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT greatest(0, qty - greatest(copies, ceil(qty::numeric * pct / 100)::integer)) $$;

CREATE FUNCTION storefront_by_slug(p_slug text)
RETURNS TABLE (
    tenant_id         uuid,
    slug              text,
    display_name      text,
    location_id       uuid,
    holdback_copies   integer,
    holdback_pct      integer,
    reservation_hours integer,
    pickup_text       text,
    policy_text       text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.tenant_id, s.slug, s.display_name, s.location_id, s.holdback_copies,
           s.holdback_pct, s.reservation_hours, s.pickup_text, s.policy_text
    FROM public.storefront s
    WHERE s.slug = p_slug AND s.published
$$;

CREATE FUNCTION published_storefronts()
RETURNS TABLE (
    tenant_id         uuid,
    slug              text,
    display_name      text,
    location_id       uuid,
    holdback_copies   integer,
    holdback_pct      integer,
    reservation_hours integer,
    pickup_text       text,
    policy_text       text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.tenant_id, s.slug, s.display_name, s.location_id, s.holdback_copies,
           s.holdback_pct, s.reservation_hours, s.pickup_text, s.policy_text
    FROM public.storefront s
    WHERE s.published
    ORDER BY s.slug
$$;

REVOKE EXECUTE ON FUNCTION web_available(integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront_by_slug(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION published_storefronts() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION web_available(integer, integer, integer)
    TO tcg_pos_app, tcg_pos_worker;
GRANT EXECUTE ON FUNCTION storefront_by_slug(text) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION published_storefronts() TO tcg_pos_worker;
