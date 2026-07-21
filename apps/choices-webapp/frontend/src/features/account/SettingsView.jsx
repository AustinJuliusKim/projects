import React from "react";
import { authEnabled, hasSession, getProfile, signIn, signOut } from "@/lib/auth.js";
import { invalidateMe } from "@/hooks/useMe.js";
import Button from "@/components/Button.jsx";

const ADMIN_FLAG = "choices:admin";

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

// Settings tab: account (sign in/out), Premium link, and the owner-only admin
// link (unlocked by a #/admin visit, see AdminView.jsx).
export default function SettingsView() {
  const signedIn = hasSession();
  const isAdmin = authEnabled && localStorage.getItem(ADMIN_FLAG) === "1";

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
