import React, { useEffect } from "react";
import { authEnabled, hasSession, getProfile } from "./auth.js";
import { readStreak } from "./streakCache.js";

// Persistent top-right pill to My games (#/account) on every view. Reads are
// synchronous (auth localStorage + streak cache) — it never calls the API.
// Hidden entirely when accounts are unavailable (includes the iOS shell).
export default function AccountCorner() {
  useEffect(() => {
    if (!authEnabled) return;
    document.body.classList.add("account-corner-active");
    return () => document.body.classList.remove("account-corner-active");
  }, []);

  if (!authEnabled) return null;

  if (!hasSession()) {
    return (
      <a className="account-corner muted-chip" href="#/account">
        Sign in
      </a>
    );
  }

  const cached = readStreak(getProfile()?.sub);
  const streak =
    cached && !cached.streakLocked && cached.currentStreak >= 1
      ? cached.currentStreak
      : null;

  return (
    <a className="account-corner" href="#/account" aria-label="My games">
      📜
      {streak != null && <span className="account-corner-streak">🔥{streak}</span>}
    </a>
  );
}
