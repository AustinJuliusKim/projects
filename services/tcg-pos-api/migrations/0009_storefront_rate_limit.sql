-- 0009_storefront_rate_limit: fixed-window per-IP counters for the public
-- storefront's writes (cart quote, reserve order).
--
-- Why it looks like this:
--   * In the database, not in process memory: the API runs on Lambda, where
--     every concurrent instance would keep its own counts and a cold start
--     resets them. Same approach as services/mtg-api's rate_counters: one row
--     per (bucket, window), bumped by a single INSERT ... ON CONFLICT DO
--     UPDATE, so it is one round trip and race-free.
--   * Buckets are not tenant data (an IP is limited across every store), so
--     the table has no tenant_id. Like search_outbox (0007) it is reached
--     only through SECURITY DEFINER functions running as the owner: RLS is
--     ENABLEd with no policy at all and nothing is granted, so every other
--     role sees and writes nothing, and it is not FORCEd so the owner needs
--     no BYPASSRLS.
--   * storefront_rate_hit(bucket, window_seconds) returns the bucket's count
--     in the current window including this hit; the API compares it to the
--     limit. Granted to tcg_pos_app.
--   * prune_storefront_rate_counters() drops windows older than a day; the
--     reservation-expiry job calls it (granted to tcg_pos_worker).

CREATE TABLE storefront_rate_counter (
    bucket       text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 200),
    window_start timestamptz NOT NULL,
    hits         integer NOT NULL,
    PRIMARY KEY (bucket, window_start)
);

ALTER TABLE storefront_rate_counter ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE storefront_rate_counter FROM PUBLIC;

CREATE FUNCTION storefront_rate_hit(p_bucket text, p_window_seconds integer) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO public.storefront_rate_counter AS c (bucket, window_start, hits)
    VALUES (
        p_bucket,
        to_timestamp(
            floor(extract(epoch FROM now()) / greatest(p_window_seconds, 1))
            * greatest(p_window_seconds, 1)),
        1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = c.hits + 1
    RETURNING c.hits
$$;

CREATE FUNCTION prune_storefront_rate_counters() RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH gone AS (
        DELETE FROM public.storefront_rate_counter
        WHERE window_start < now() - interval '1 day'
        RETURNING 1)
    SELECT count(*)::integer FROM gone
$$;

REVOKE EXECUTE ON FUNCTION storefront_rate_hit(text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prune_storefront_rate_counters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_rate_hit(text, integer) TO tcg_pos_app;
GRANT EXECUTE ON FUNCTION prune_storefront_rate_counters() TO tcg_pos_worker;
