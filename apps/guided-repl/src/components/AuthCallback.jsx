/**
 * Email-link landing: /auth/callback?token_hash=…&type=(magiclink|signup).
 * Exchanges the token for a session (merging anonymous progress server-side),
 * rewrites the URL back to "/", and hands control back to the app. If Supabase
 * hands back an error (query string or hash), it's surfaced instead of the
 * link being treated as a silent no-op.
 */

import { useEffect, useRef, useState } from "react";
import { verifyMagicLink } from "../api/client.js";
import { useIdentity } from "../identity/IdentityContext.jsx";

/**
 * @param {{onDone: () => void}} props
 */
export default function AuthCallback({ onDone }) {
  const { anonId, refreshSession } = useIdentity();
  const [failed, setFailed] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    (async () => {
      // Supabase can hand back an error in either the query string or the URL
      // hash (e.g. #error=access_denied&error_description=…). Read both before
      // we rewrite the URL, so a misconfigured link fails visibly instead of
      // silently dropping the user into an anonymous session.
      const params = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const error = params.get("error") ?? hashParams.get("error");
      const errorDescription =
        params.get("error_description") ?? hashParams.get("error_description");
      const tokenHash = params.get("token_hash");
      const type = params.get("type") ?? "magiclink";
      const result =
        !error && tokenHash ? await verifyMagicLink({ tokenHash, type, anonId }) : null;
      window.history.replaceState(null, "", "/");
      if (result?.user) {
        await refreshSession();
        onDone();
      } else {
        if (error) setErrorMessage(errorDescription?.replace(/\+/g, " ") ?? error);
        setFailed(true);
      }
    })();
  }, [anonId, refreshSession, onDone]);

  return (
    <div className="app-shell">
      <div className="load-status" data-testid="auth-callback">
        {failed ? (
          <>
            {errorMessage ?? "That sign-in link is invalid or expired."}{" "}
            <button type="button" className="rail-continue" onClick={onDone}>
              Back to lessons
            </button>
          </>
        ) : (
          "Signing you in…"
        )}
      </div>
    </div>
  );
}
