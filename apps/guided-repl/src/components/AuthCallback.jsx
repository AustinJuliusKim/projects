/**
 * Magic-link landing: /auth/callback?token_hash=…&type=magiclink. Exchanges
 * the token for a session (merging anonymous progress server-side), rewrites
 * the URL back to "/", and hands control back to the app.
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
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const tokenHash = params.get("token_hash");
      const type = params.get("type") ?? "magiclink";
      const result = tokenHash ? await verifyMagicLink({ tokenHash, type, anonId }) : null;
      window.history.replaceState(null, "", "/");
      if (result?.user) {
        await refreshSession();
        onDone();
      } else {
        setFailed(true);
      }
    })();
  }, [anonId, refreshSession, onDone]);

  return (
    <div className="app-shell">
      <div className="load-status" data-testid="auth-callback">
        {failed ? (
          <>
            That sign-in link is invalid or expired.{" "}
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
