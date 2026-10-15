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

-- ---------------------------------------------------------------------------
-- PIN lockout per register device, with a store-wide ceiling
--
-- The 0012 lockout counted failures per (store, person): anyone standing at
-- one enrolled register could lock a manager's PIN on every register in the
-- store with five wrong guesses. Now (auth/pins.py):
--   * staff_pin_device counts consecutive failures per (person, device) and
--     carries the old schedule: the 5th locks that PIN *on that device* for
--     1 minute, doubling to 1 hour. Other registers are unaffected.
--   * staff_pin.fail_count / locked_until become the store-wide ceiling:
--     consecutive failures on any device since the last success, plus
--     fail_devices, the devices they came from. Once there are 11 of them
--     from at least two devices, each further failure locks the PIN
--     everywhere for an hour. One register alone can't trip it (it is
--     already held to the per-device schedule); spreading guesses over
--     several registers can't beat the old per-person rate either. The
--     arithmetic is in docs/AUTH_PLAN.md.
--   * A correct PIN resets the store-wide count and that device's count;
--     setting a new PIN resets everything.

ALTER TABLE staff_pin ADD COLUMN fail_devices uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE staff_pin_device (
    tenant_id    uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenant (id),
    user_id      uuid NOT NULL,
    device_id    uuid NOT NULL,
    fail_count   integer NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
    locked_until timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, device_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES staff_pin (tenant_id, user_id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES register_device (tenant_id, id)
);

ALTER TABLE staff_pin_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_pin_device FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_pin_device
    USING (tenant_id = (SELECT current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()));

GRANT UPDATE (fail_devices) ON staff_pin TO tcg_pos_app;
GRANT SELECT, INSERT (user_id, device_id, fail_count, locked_until),
    UPDATE (fail_count, locked_until, updated_at) ON staff_pin_device TO tcg_pos_app;

-- ---------------------------------------------------------------------------
-- an invite is only as good as its inviter's standing
--
-- An invite used to stay acceptable for its 7 days even after the person
-- who sent it was disabled or demoted. Now accept_invite also requires the
-- inviter to still be an active member of the store who could grant the
-- invite's role today: holds staff.manage and every permission of the role,
-- and is an owner for an owner invite (routes/staff.check_grantable's
-- rules). Otherwise the status is 'inviter_inactive' and the API answers
-- 410 (ask for a new invite). The invite stays pending, so it works again
-- if the inviter's access is restored. Otherwise the same as 0011.

CREATE OR REPLACE FUNCTION accept_invite(p_sub text, p_token_hash text)
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
    v_role_system boolean;
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
    SELECT r.key, r.is_system INTO v_role, v_role_system
    FROM public.role r WHERE r.id = v_inv.role_id;
    v_status := CASE
        WHEN v_inv.revoked_at IS NOT NULL THEN 'revoked'
        WHEN v_inv.accepted_at IS NOT NULL THEN 'used'
        WHEN v_inv.expires_at <= now() THEN 'expired'
    END;
    IF v_status IS NULL AND NOT EXISTS (
        SELECT 1
        FROM public.membership im
        JOIN public.role ir ON ir.id = im.role_id
        WHERE im.tenant_id = v_inv.tenant_id AND im.user_id = v_inv.invited_by
          AND im.status = 'active'
          AND EXISTS (SELECT 1 FROM public.role_permission p
                      WHERE p.role_id = ir.id AND p.perm = 'staff.manage')
          AND NOT EXISTS (SELECT 1 FROM public.role_permission need
                          WHERE need.role_id = v_inv.role_id
                            AND NOT EXISTS (SELECT 1 FROM public.role_permission have
                                            WHERE have.role_id = ir.id
                                              AND have.perm = need.perm))
          AND (NOT (v_role_system AND v_role = 'owner')
               OR (ir.tenant_id IS NULL AND ir.key = 'owner'))
    ) THEN
        v_status := 'inviter_inactive';
    END IF;
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
