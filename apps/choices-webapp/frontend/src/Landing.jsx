import React from "react";
import IosInstallHint from "./IosInstallHint.jsx";
import NavButton from "./NavButton.jsx";
import { authEnabled, hasSession } from "./auth.js";

// First screen for a device with no identity yet: start a new pairing, or join
// an existing one with a code. The brand lockup lives in the persistent top bar.
export default function Landing() {
  return (
    <div className="container">
      <p className="muted">
        Decide what to eat, together. 4 choices, 3 cuts, 1 winner — no blame,
        no apathy.
      </p>

      <NavButton variant="primary" href="#/create">
        ➕ Start a new game
      </NavButton>
      <NavButton href="#/join">
        🔑 Enter a game code
      </NavButton>
      {/* Signed-in users reach History via the bottom nav; this ghost
          button stays as the guest conversion CTA. */}
      {authEnabled && !hasSession() && (
        <NavButton variant="ghost" href="#/history">
          📜 Sign in for game history
        </NavButton>
      )}

      <IosInstallHint />
    </div>
  );
}
