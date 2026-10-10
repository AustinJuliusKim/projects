-- 0008_web_order: reserve-for-pickup orders placed on the public storefront.
--
-- Why it looks like this:
--   * No payment yet: an order *reserves* stock at the storefront's location
--     for pickup. Placing it decrements inventory_item.qty with a ledger row
--     per line (channel 'web', reason 'web_reserve:<order id>', negative
--     delta); cancel and expiry put it back with the mirror-image rows
--     ('web_cancel:<id>' / 'web_expire:<id>'). Picked-up orders keep their
--     decrement — that is the sale.
--   * status moves only out of 'reserved' (reserved -> picked_up |
--     cancelled | expired), enforced by a trigger for every role, so a
--     reversal can never run twice: the API locks the order row, sees it is
--     no longer reserved and stops.
--   * Lines snapshot what was reserved (grain, unit price) so later price or
--     catalog edits don't rewrite history; total_cents is bigint because 40
--     lines × 20 copies × an int32 price can exceed integer. `name` is
--     nullable: the POS DB has printing ids, not names (they live in
--     mtg-api), so it is filled only when the caller has one.
--   * idempotency_key is unique per tenant: a retried POST returns the
--     original order instead of reserving twice.
--   * pickup_code is a short code (no 0/O/1/I) the customer shows at the
--     counter; it also gates the public confirmation page.
--   * Same tenancy rules as 0001: RLS enabled + forced, composite FKs. The
--     app role gets SELECT/INSERT and UPDATE of (status, updated_at) only on
--     web_order, SELECT/INSERT on web_order_line, and no DELETE.
--   * The expiry job must find due orders across tenants. It does that
--     through web_orders_due_for_expiry() (SECURITY DEFINER, granted to
--     tcg_pos_worker), admitted by a SELECT policy scoped TO the migrating
--     role for due reservations only — the same owner-policy pattern as
--     storefront_by_slug in 0006 — and then reverses each order as
--     tcg_pos_app with that order's tenant set, through the normal RLS path.

CREATE TABLE web_order (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    location_id     uuid NOT NULL,
    status          text NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'picked_up', 'cancelled', 'expired')),
    pickup_code     text NOT NULL CHECK (pickup_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
    customer_name   text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 100),
    customer_email  text NOT NULL CHECK (length(customer_email) BETWEEN 3 AND 254),
    customer_phone  text CHECK (length(customer_phone) <= 40),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,100}$'),
    total_cents     bigint NOT NULL CHECK (total_cents >= 0),
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);

CREATE INDEX web_order_list_idx ON web_order (tenant_id, status, created_at);
CREATE INDEX web_order_due_idx ON web_order (expires_at) WHERE status = 'reserved';

CREATE TABLE web_order_line (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL DEFAULT current_tenant_id(),
    web_order_id      uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    printing_id       uuid NOT NULL,
    game              text NOT NULL,
    condition         text NOT NULL CHECK (condition IN ('NM', 'LP', 'MP', 'HP', 'DMG')),
    finish            text NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
    lang              text NOT NULL,
    name              text CHECK (length(name) <= 300),
    unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
    qty               integer NOT NULL CHECK (qty > 0),
    FOREIGN KEY (tenant_id, web_order_id) REFERENCES web_order (tenant_id, id),
    FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_item (tenant_id, id),
    UNIQUE (tenant_id, web_order_id, inventory_item_id)
);

CREATE INDEX web_order_line_order_idx ON web_order_line (tenant_id, web_order_id);

-- ---------------------------------------------------------------------------
-- status may only leave 'reserved'

CREATE FUNCTION web_order_status_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'reserved' THEN
        RAISE EXCEPTION 'web_order % is %, it can no longer become %', OLD.id, OLD.status,
            NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER web_order_status_guard
    BEFORE UPDATE OF status ON web_order
    FOR EACH ROW EXECUTE FUNCTION web_order_status_guard();

CREATE TRIGGER web_order_line_append_only
    BEFORE UPDATE OR DELETE ON web_order_line
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- row-level security

ALTER TABLE web_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_order FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON web_order
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

ALTER TABLE web_order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_order_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON web_order_line
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

DO $$
BEGIN
    EXECUTE format(
        'CREATE POLICY definer_due_read ON web_order FOR SELECT TO %I '
        'USING (status = %L AND expires_at <= now())',
        current_user, 'reserved');
END
$$;

-- ---------------------------------------------------------------------------
-- expiry lookup (cross-tenant ids only; the reversal itself runs under RLS)

CREATE FUNCTION web_orders_due_for_expiry(max_rows integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.tenant_id, o.id
    FROM public.web_order o
    WHERE o.status = 'reserved' AND o.expires_at <= now()
    ORDER BY o.expires_at, o.id
    LIMIT least(greatest(coalesce(max_rows, 1), 1), 5000)
$$;

REVOKE EXECUTE ON FUNCTION web_order_status_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION web_orders_due_for_expiry(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION web_orders_due_for_expiry(integer) TO tcg_pos_worker;

-- ---------------------------------------------------------------------------
-- app-role grants

GRANT SELECT, INSERT ON web_order, web_order_line TO tcg_pos_app;
GRANT UPDATE (status, updated_at) ON web_order TO tcg_pos_app;
