-- 0005_price_rule: the store's rule for turning a market reference price into
-- a suggested shelf price (the roadmap's PriceRule entity).
--
-- Why it looks like this:
--   * One row per tenant (tenant_id is the primary key). No row means "use the
--     defaults", which are the column defaults here and pricing.DEFAULT_RULE in
--     the API — so a new store gets sane suggestions without setup.
--   * Condition multipliers are integer basis points (10000 = 100%), so the
--     suggestion is integer math end to end: no floats touch money. Defaults
--     NM 100%, LP 90%, MP 75%, HP 60%, DMG 40%. Capped at 1000% so a typo
--     can't price a card at 10,000x.
--   * The formula (pricing.apply_rule):
--       scaled    = round_half_up(reference_cents * condition_bp / 10000)
--       rounded   = scaled rounded UP to a multiple of round_up_to_cents
--       suggested = max(rounded, min_price_cents)
--     round_up_to_cents = 1 means no rounding; the default 25 rounds up to the
--     next quarter. min_price_cents is the bulk floor (default $0.25).
--   * The rule is only a suggestion: prices are set explicitly on
--     inventory_item and every rule change is audit-logged by the API.
--   * Same tenancy rules as 0001: tenant_id defaults from the request's GUC,
--     RLS enabled + forced, the app role has no DELETE.

CREATE TABLE price_rule (
    tenant_id         uuid PRIMARY KEY DEFAULT current_tenant_id() REFERENCES tenant (id),
    nm_bp             integer NOT NULL DEFAULT 10000 CHECK (nm_bp BETWEEN 0 AND 100000),
    lp_bp             integer NOT NULL DEFAULT 9000 CHECK (lp_bp BETWEEN 0 AND 100000),
    mp_bp             integer NOT NULL DEFAULT 7500 CHECK (mp_bp BETWEEN 0 AND 100000),
    hp_bp             integer NOT NULL DEFAULT 6000 CHECK (hp_bp BETWEEN 0 AND 100000),
    dmg_bp            integer NOT NULL DEFAULT 4000 CHECK (dmg_bp BETWEEN 0 AND 100000),
    min_price_cents   integer NOT NULL DEFAULT 25 CHECK (min_price_cents >= 0),
    round_up_to_cents integer NOT NULL DEFAULT 25
                      CHECK (round_up_to_cents BETWEEN 1 AND 10000),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE price_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON price_rule
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

GRANT SELECT, INSERT, UPDATE ON price_rule TO tcg_pos_app;
