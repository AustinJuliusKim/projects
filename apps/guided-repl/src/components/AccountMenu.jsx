/**
 * Header account widget. Signed out: "Sign in" → email → magic link →
 * "check your email" (works offline — the request is fire-and-forget).
 * Signed in: name/email, marketing-consent toggle, export, sign out, and
 * the delete-account danger action (confirm()-gated).
 */

import { useState } from "react";
import { requestMagicLink, patchAccount, deleteAccount, logout } from "../api/client.js";
import { useIdentity } from "../identity/IdentityContext.jsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AccountMenu() {
  const { anonId, user, refreshSession } = useIdentity();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);

  async function sendLink() {
    if (!EMAIL_RE.test(email.trim())) return;
    requestMagicLink(email.trim(), anonId); // fire-and-forget
    setLinkSent(true);
  }

  async function onToggleMarketing(e) {
    await patchAccount({ marketingConsent: e.target.checked });
    refreshSession();
  }

  async function onSignOut() {
    await logout();
    await refreshSession();
    setOpen(false);
  }

  async function onDelete() {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Delete your account? Progress, wallet, and personal data are removed permanently.")) return;
    await deleteAccount();
    await refreshSession();
    setOpen(false);
  }

  return (
    <div className="account-menu" data-testid="account-menu">
      <button
        type="button"
        className="account-trigger"
        data-testid="account-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        {user ? (user.name ?? user.email) : "Sign in"}
      </button>

      {open && !user && (
        <div className="account-panel" data-testid="account-panel">
          {linkSent ? (
            <p className="account-note" data-testid="magic-link-sent">
              Check your email for a sign-in link.
            </p>
          ) : (
            <>
              <p className="account-note">Get a magic link — no password.</p>
              <input
                type="email"
                className="capture-input"
                data-testid="signin-email-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendLink()}
              />
              <button
                type="button"
                className="capture-submit"
                data-testid="signin-submit"
                disabled={!EMAIL_RE.test(email.trim())}
                onClick={sendLink}
              >
                Send magic link
              </button>
            </>
          )}
        </div>
      )}

      {open && user && (
        <div className="account-panel" data-testid="account-panel">
          <p className="account-note">
            {user.name ? `${user.name} · ` : ""}
            {user.email}
          </p>
          <label className="capture-consent">
            <input
              type="checkbox"
              data-testid="marketing-toggle"
              checked={user.marketingConsent}
              onChange={onToggleMarketing}
            />
            Newsletter (occasional, unsubscribe anytime)
          </label>
          <a className="account-link" href="/api/account/export" download>
            Export my data
          </a>
          <button type="button" className="capture-skip" data-testid="sign-out" onClick={onSignOut}>
            Sign out
          </button>
          <button type="button" className="account-danger" data-testid="delete-account" onClick={onDelete}>
            Delete account
          </button>
        </div>
      )}
    </div>
  );
}
