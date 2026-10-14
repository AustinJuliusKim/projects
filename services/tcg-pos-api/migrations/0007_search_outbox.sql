-- 0007_search_outbox: a transactional outbox telling the listings indexer
-- (tcg_pos_api.search.listings, M5) which store × printing to rebuild.
--
-- Why it looks like this:
--   * Triggers, not API code, write the events: every path that changes what
--     a store sells online (adjust, price PATCH, CSV import, web orders and
--     their cancel/expiry, storefront settings) goes through inventory_item
--     or storefront, so an event lands in the same transaction as the change
--     and disappears with it on rollback. No code path can forget it.
--   * An event is (tenant_id, printing_id): "rebuild this printing's card in
--     this store". printing_id NULL means "rebuild the whole store" (the
--     storefront was published/unpublished or its location/holdback moved).
--     Events carry no state; the consumer re-reads Postgres, so duplicate or
--     reordered events are harmless and it coalesces them per card.
--   * pg_notify('search_outbox', '') wakes a LISTENing consumer at commit
--     (Postgres drops identical notifications within one transaction).
--   * RLS is ENABLEd but deliberately not FORCEd — the same choice as
--     schema_migrations in 0003. claim/ack are SECURITY DEFINER and run as
--     the owning (migrating) role, which must see every tenant's events; not
--     forcing RLS exempts the owner without needing BYPASSRLS. Everyone else
--     is bound by policy: tcg_pos_app gets an INSERT-only policy for its own
--     tenant (the triggers run as the invoker) plus INSERT and sequence
--     USAGE, and no SELECT/UPDATE/DELETE grant at all, so request code can
--     enqueue but never read, reorder or drop events.
--   * The consumer only touches the table through two functions, granted to
--     tcg_pos_worker (0006) and nobody else:
--       claim_search_outbox(max_rows integer)
--         -> TABLE(id bigint, tenant_id uuid, printing_id uuid, created_at)
--         Oldest first, at most max_rows (clamped to 1..5000), each row
--         locked FOR UPDATE SKIP LOCKED in the CALLER's transaction: two
--         consumers never get the same row, and a claim lasts exactly as
--         long as that transaction.
--       ack_search_outbox(ids bigint[]) -> integer (rows deleted)
--     Contract: BEGIN; SET LOCAL ROLE tcg_pos_worker; claim; rebuild the
--     claimed cards and push them to OpenSearch; ack the ids only after the
--     bulk request succeeded; COMMIT. Any failure (or a crash) rolls back,
--     which releases the locks and leaves the events for the next claim —
--     delivery is at-least-once. An event enqueued after the claim is a new
--     row, so a change racing a rebuild is never lost.

CREATE TABLE search_outbox (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    printing_id uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE search_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_enqueue ON search_outbox FOR INSERT TO tcg_pos_app
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

REVOKE ALL ON TABLE search_outbox FROM PUBLIC;
GRANT INSERT ON search_outbox TO tcg_pos_app;
GRANT USAGE ON SEQUENCE search_outbox_id_seq TO tcg_pos_app;

-- ---------------------------------------------------------------------------
-- triggers (invoker rights: they insert as whoever changed the row)

CREATE FUNCTION enqueue_item_search() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.search_outbox (tenant_id, printing_id)
    VALUES (NEW.tenant_id, NEW.printing_id);
    IF TG_OP = 'UPDATE' AND OLD.printing_id IS DISTINCT FROM NEW.printing_id THEN
        INSERT INTO public.search_outbox (tenant_id, printing_id)
        VALUES (OLD.tenant_id, OLD.printing_id);
    END IF;
    PERFORM pg_notify('search_outbox', '');
    RETURN NULL;
END
$$;

CREATE FUNCTION enqueue_storefront_search() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.search_outbox (tenant_id, printing_id) VALUES (NEW.tenant_id, NULL);
    PERFORM pg_notify('search_outbox', '');
    RETURN NULL;
END
$$;

-- A new row with nothing on hand can't be listed (lock_or_create_item
-- inserts qty 0 and then updates it, which fires the update trigger).
CREATE TRIGGER inventory_item_search_insert
    AFTER INSERT ON inventory_item
    FOR EACH ROW WHEN (NEW.qty > 0)
    EXECUTE FUNCTION enqueue_item_search();

-- Beyond qty/price/location, the grain columns are included because they
-- change what the listing shows; the API never updates them today.
CREATE TRIGGER inventory_item_search_update
    AFTER UPDATE OF qty, price_cents, location_id, printing_id, condition, finish, lang
    ON inventory_item
    FOR EACH ROW WHEN (
        (OLD.qty, OLD.price_cents, OLD.location_id, OLD.printing_id, OLD.condition,
         OLD.finish, OLD.lang)
        IS DISTINCT FROM
        (NEW.qty, NEW.price_cents, NEW.location_id, NEW.printing_id, NEW.condition,
         NEW.finish, NEW.lang))
    EXECUTE FUNCTION enqueue_item_search();

CREATE TRIGGER storefront_search_insert
    AFTER INSERT ON storefront
    FOR EACH ROW EXECUTE FUNCTION enqueue_storefront_search();

-- Only what changes listings: display text (name, policy, pickup) doesn't.
CREATE TRIGGER storefront_search_update
    AFTER UPDATE ON storefront
    FOR EACH ROW WHEN (
        (OLD.published, OLD.slug, OLD.location_id, OLD.holdback_copies, OLD.holdback_pct)
        IS DISTINCT FROM
        (NEW.published, NEW.slug, NEW.location_id, NEW.holdback_copies, NEW.holdback_pct))
    EXECUTE FUNCTION enqueue_storefront_search();

-- ---------------------------------------------------------------------------
-- consumer functions (see the contract above)

CREATE FUNCTION claim_search_outbox(max_rows integer)
RETURNS TABLE (id bigint, tenant_id uuid, printing_id uuid, created_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.id, o.tenant_id, o.printing_id, o.created_at
    FROM public.search_outbox o
    ORDER BY o.id
    LIMIT least(greatest(coalesce(max_rows, 1), 1), 5000)
    FOR UPDATE SKIP LOCKED
$$;

CREATE FUNCTION ack_search_outbox(ids bigint[]) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH gone AS (DELETE FROM public.search_outbox o WHERE o.id = ANY (ids) RETURNING 1)
    SELECT count(*)::integer FROM gone
$$;

REVOKE EXECUTE ON FUNCTION enqueue_item_search() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enqueue_storefront_search() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_search_outbox(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ack_search_outbox(bigint[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION claim_search_outbox(integer) TO tcg_pos_worker;
GRANT EXECUTE ON FUNCTION ack_search_outbox(bigint[]) TO tcg_pos_worker;
