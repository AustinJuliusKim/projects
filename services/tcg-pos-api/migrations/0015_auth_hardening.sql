-- 0015_auth_hardening: fixes from the security review of the auth + RBAC
-- branch (docs/AUTH_PLAN.md, "Security review fixes").
--
-- Why it looks like this:
--   * Last owner, under concurrency. membership_last_owner_guard (0011)
--     checked "is another active owner left?" without serializing, so two
--     transactions demoting/disabling the store's two owners at once could
--     each see the other still active and both commit, leaving none. The
--     guard now takes the same per-store advisory lock the API's staff
--     routes take first (routes/staff._lock_staff:
--     hashtextextended('membership:<tenant uuid>', 0)) before it looks. In
--     READ COMMITTED (the API's level) every statement after the lock gets a
--     fresh snapshot, so the second transaction waits for the first to
--     commit and then sees its change. A REPEATABLE READ transaction keeps
--     its old snapshot even after the lock, so the guard refuses owner
--     changes there outright rather than check stale data (SERIALIZABLE is
--     fine: SSI aborts the write skew).
--   * Register sessions end when the person's access changes. A session is
--     re-checked against the membership on every request, but a disabled
--     member's session used to come back to life when they were re-enabled,
--     and a role change kept it. A trigger now ends the member's open
--     register sessions in that store whenever their status or role
--     changes, whoever makes the change (API, accept_invite, SQL). A PIN
--     change ends them in the API (routes/registers.set_my_pin), where the
--     rehash-on-sign-in path can't trip it.

-- ---------------------------------------------------------------------------
-- last-owner guard, serialized

CREATE OR REPLACE FUNCTION membership_last_owner_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    owner_role uuid := (SELECT r.id FROM public.role r
                        WHERE r.tenant_id IS NULL AND r.key = 'owner');
BEGIN
    IF OLD.status = 'active' AND OLD.role_id = owner_role
       AND (NEW.status <> 'active' OR NEW.role_id <> owner_role) THEN
        IF current_setting('transaction_isolation') = 'repeatable read' THEN
            RAISE EXCEPTION 'change store owners in a READ COMMITTED or SERIALIZABLE transaction'
                USING ERRCODE = 'serialization_failure';
        END IF;
        -- Same key as routes/staff._lock_staff (re-entrant within one
        -- transaction, so the API's own lock doesn't deadlock with this).
        PERFORM pg_advisory_xact_lock(hashtextextended('membership:' || OLD.tenant_id::text, 0));
        IF NOT EXISTS (SELECT 1 FROM public.membership m
                       WHERE m.tenant_id = OLD.tenant_id AND m.status = 'active'
                         AND m.role_id = owner_role) THEN
            RAISE EXCEPTION 'store % would have no active owner', OLD.tenant_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- a status or role change ends the member's register sessions

CREATE FUNCTION membership_end_register_sessions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.register_session s SET ended_at = now()
    WHERE s.tenant_id = NEW.tenant_id AND s.user_id = NEW.user_id AND s.ended_at IS NULL;
    RETURN NULL;
END
$$;

CREATE TRIGGER membership_end_sessions
    AFTER UPDATE OF status, role_id ON membership
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.role_id IS DISTINCT FROM NEW.role_id)
    EXECUTE FUNCTION membership_end_register_sessions();

REVOKE EXECUTE ON FUNCTION membership_end_register_sessions() FROM PUBLIC;
