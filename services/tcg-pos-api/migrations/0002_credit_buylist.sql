-- 0002_credit_buylist: customers, the store-credit ledger, and buylist tables.
--
-- Why it looks like this:
--   * Store credit is a ledger, not a balance column: every issue/redeem is
--     an append-only credit_ledger row (signed delta_cents), and the balance
--     is derived by the customer_credit_balance view. That gives a complete
--     history for disputes and makes "who gave this customer $40" answerable.
--     Concurrency (two registers redeeming at once) is handled in the API by
--     locking the customer row (SELECT ... FOR UPDATE) before reading the
--     balance, so the balance can never go negative.
--   * The view is security_invoker so it is evaluated with the caller's
--     privileges and RLS, not the view owner's.
--   * buylist / buylist_offer are schema only for now (Phase 2 builds the
--     engine). Offer amounts are integer cents and NULL until an offer is
--     actually made — NULL means "no offer yet", never "offered $0".
--   * Same tenancy rules as 0001: tenant_id defaults from the request's GUC,
--     RLS enabled + forced, composite (tenant_id, id) FKs, app role has no
--     DELETE, and credit_ledger rejects UPDATE/DELETE/TRUNCATE for everyone.

CREATE TABLE customer (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    name       text NOT NULL,
    email      text,
    phone      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE credit_ledger (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id(),
    customer_id uuid NOT NULL,
    delta_cents integer NOT NULL CHECK (delta_cents <> 0),
    reason      text NOT NULL,
    actor       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id)
);

CREATE INDEX credit_ledger_customer_idx ON credit_ledger (tenant_id, customer_id, created_at);

CREATE TRIGGER credit_ledger_append_only
    BEFORE UPDATE OR DELETE ON credit_ledger
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER credit_ledger_no_truncate
    BEFORE TRUNCATE ON credit_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- A customer with no ledger rows has a known balance of 0 (not unknown).
CREATE VIEW customer_credit_balance WITH (security_invoker = true) AS
SELECT c.tenant_id,
       c.id AS customer_id,
       coalesce(sum(l.delta_cents), 0)::bigint AS balance_cents
FROM customer c
LEFT JOIN credit_ledger l ON l.tenant_id = c.tenant_id AND l.customer_id = c.id
GROUP BY c.tenant_id, c.id;

-- ---------------------------------------------------------------------------
-- buylist (schema only)

CREATE TABLE buylist (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id(),
    location_id uuid NOT NULL,
    customer_id uuid,
    status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'offered', 'accepted', 'declined', 'cancelled')),
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id)
);

CREATE TABLE buylist_offer (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL DEFAULT current_tenant_id(),
    buylist_id         uuid NOT NULL,
    printing_id        uuid NOT NULL,
    game               text NOT NULL DEFAULT 'mtg',
    condition          text NOT NULL CHECK (condition IN ('NM', 'LP', 'MP', 'HP', 'DMG')),
    finish             text NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
    lang               text NOT NULL DEFAULT 'en',
    qty                integer NOT NULL CHECK (qty > 0),
    cash_offer_cents   integer CHECK (cash_offer_cents >= 0),
    credit_offer_cents integer CHECK (credit_offer_cents >= 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, buylist_id) REFERENCES buylist (tenant_id, id)
);

CREATE INDEX buylist_offer_buylist_idx ON buylist_offer (tenant_id, buylist_id);

-- ---------------------------------------------------------------------------
-- row-level security

ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_ledger
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE buylist ENABLE ROW LEVEL SECURITY;
ALTER TABLE buylist FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON buylist
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE buylist_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE buylist_offer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON buylist_offer
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

-- ---------------------------------------------------------------------------
-- app-role grants

GRANT SELECT, INSERT, UPDATE ON customer, buylist, buylist_offer TO tcg_pos_app;
GRANT SELECT, INSERT ON credit_ledger TO tcg_pos_app;
GRANT SELECT ON customer_credit_balance TO tcg_pos_app;
