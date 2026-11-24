-- 0014_user_identity: set a user's email and display name from their
-- verified ID token (docs/AUTH_PLAN.md, milestone A4).
--
-- Why it looks like this:
--   * Cognito access tokens carry no email, and the pool stays on the Lite
--     tier (no access-token customization), so after sign-in the app posts
--     the ID token from the same login to POST /v1/me/identity. The API
--     verifies it (signature, iss, aud, token_use, sub == the access
--     token's sub, email_verified) and calls this function. Invite
--     acceptance keeps comparing the invite to app_user.email (0011).
--   * app_user is owner-only (0011), hence SECURITY DEFINER. The email is
--     lower-cased; a NULL/blank display name keeps the stored one.

CREATE FUNCTION set_user_identity(p_sub text, p_email text, p_display_name text)
RETURNS TABLE (id uuid, email text, display_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    UPDATE public.app_user u
    SET email = lower(btrim(p_email)),
        display_name = coalesce(nullif(btrim(p_display_name), ''), u.display_name)
    WHERE u.cognito_sub = p_sub;
    RETURN QUERY
        SELECT u.id, u.email, u.display_name FROM public.app_user u WHERE u.cognito_sub = p_sub;
END
$$;

REVOKE EXECUTE ON FUNCTION set_user_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_user_identity(text, text, text) TO tcg_pos_app;
