/**
 * Rail panel for the final graduation (l8, completion.next === null) — the
 * conversion moment from the Accounts spec: shareable badge, copy-link, and
 * one-click account creation via magic link (email pre-filled when it was
 * captured earlier in the funnel).
 */

import { useState } from "react";
import { requestMagicLink } from "../api/client.js";
import { useIdentity } from "../identity/IdentityContext.jsx";
import CompletionBadge from "./CompletionBadge.jsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {{userName: string|null, capturedEmail: string|null}} props
 */
export default function GraduationPanel({ userName, capturedEmail }) {
  const { anonId, user } = useIdentity();
  const [email, setEmail] = useState(capturedEmail ?? "");
  const [linkSent, setLinkSent] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
    } catch {
      // Clipboard blocked: the button simply stays un-confirmed.
    }
  }

  function createAccount() {
    if (!EMAIL_RE.test(email.trim())) return;
    requestMagicLink(email.trim(), anonId); // fire-and-forget
    setLinkSent(true);
  }

  return (
    <div className="graduation-panel" data-testid="graduation-panel">
      <CompletionBadge userName={userName} />
      <button type="button" className="capture-skip" data-testid="copy-share-link" onClick={copyLink}>
        {copied ? "Link copied!" : "Copy share link"}
      </button>

      {!user &&
        (linkSent ? (
          <p className="account-note" data-testid="magic-link-sent">
            Check your email for a sign-in link — your progress comes with you.
          </p>
        ) : (
          <>
            <p className="account-note">Create your account to keep your progress.</p>
            <input
              type="email"
              className="capture-input"
              data-testid="graduation-email-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              type="button"
              className="capture-submit"
              data-testid="create-account"
              disabled={!EMAIL_RE.test(email.trim())}
              onClick={createAccount}
            >
              Create your account
            </button>
          </>
        ))}
    </div>
  );
}
