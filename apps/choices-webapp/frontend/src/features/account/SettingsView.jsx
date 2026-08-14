import React from "react";
import { authEnabled, hasSession, getProfile, signIn, signOut } from "@/lib/auth.js";
import { invalidateMe } from "@/hooks/useMe.js";
import Button from "@/components/Button.jsx";

function ProfileRow() {
  const profile = getProfile();
  const name = profile?.name ?? profile?.email ?? "Signed in";
  const initial = (profile?.name ?? profile?.email ?? "?").charAt(0).toUpperCase();
  return (
    <div className="settings-row">
      <span className="settings-avatar" aria-hidden="true">
        {initial}
      </span>
      <span>
        {name}
        {profile?.email && profile?.name && (
          <>
            <br />
            <span className="muted">{profile.email}</span>
          </>
        )}
      </span>
    </div>
  );
}

// Settings tab: account (sign in/out), Premium link, and the admin link.
// Admin visibility keys on the session's Cognito "admin" group claim — the
// same check as the #/admin route gate in main.jsx, so the row shows exactly
// where the route renders (installed PWAs have no URL bar to type it). UX
// only: a tampered local session can conjure the row, but every admin action
// re-verifies the JWT server-side (assertAdmin / assertFlagAdmin) and 403s.
export default function SettingsView() {
  const signedIn = hasSession();
  const isAdmin = Boolean(getProfile()?.groups?.includes("admin"));

  function onSignOut() {
    invalidateMe();
    signOut();
  }

  return (
    <div className="container">
      <h1>Settings</h1>

      {!authEnabled ? (
        <div className="settings-group">
          <div className="settings-row">
            Sign-in is coming soon to the app — everything works without one.
          </div>
        </div>
      ) : signedIn ? (
        <>
          <div className="settings-group">
            <ProfileRow />
            <button type="button" className="settings-row" onClick={onSignOut}>
              Sign out
              <span className="settings-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </div>
          <div className="settings-group">
            <a className="settings-row" href="#/premium">
              ✨ Premium
              <span className="settings-chevron" aria-hidden="true">
                ›
              </span>
            </a>
          </div>
          {isAdmin && (
            <div className="settings-group">
              <a className="settings-row" href="#/admin">
                Admin dashboard
                <span className="settings-chevron" aria-hidden="true">
                  ›
                </span>
              </a>
            </div>
          )}
        </>
      ) : (
        <div className="settings-group">
          <div className="settings-row">
            Sign in to keep your history, streak, and Premium in sync across
            devices.
          </div>
          <div className="settings-row">
            <Button variant="primary" onClick={signIn}>
              Continue with Google
            </Button>
          </div>
        </div>
      )}

      <p className="muted">Choices · built by one person 🦝</p>
    </div>
  );
}
