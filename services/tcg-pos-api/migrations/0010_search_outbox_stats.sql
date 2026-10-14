-- 0010_search_outbox_stats: backlog numbers for the listings indexer's
-- `status` command and monitoring.
--
-- Why it looks like this:
--   * search_outbox is owner-only (0007): no role can SELECT it, and
--     claim_search_outbox() locks the rows it returns, so peeking through it
--     would steal a live consumer's batch. A read-only SECURITY DEFINER
--     function exposes just the aggregate: how many events are queued, how
--     many are whole-store rebuilds, the oldest event's time and how many
--     tenants are affected. No ids, no rows.
--   * Granted to tcg_pos_worker only (like claim/ack); revoked from PUBLIC
--     because 0003 changed default privileges but a different migrating role
--     may not have.

CREATE FUNCTION search_outbox_stats()
RETURNS TABLE (backlog bigint, whole_store bigint, tenants bigint, oldest timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT count(*), count(*) FILTER (WHERE o.printing_id IS NULL),
           count(DISTINCT o.tenant_id), min(o.created_at)
    FROM public.search_outbox o
$$;

REVOKE EXECUTE ON FUNCTION search_outbox_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_outbox_stats() TO tcg_pos_worker;
