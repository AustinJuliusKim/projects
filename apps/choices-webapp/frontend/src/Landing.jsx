import React from "react";
import IosInstallHint from "./IosInstallHint.jsx";
import TipJar from "./support.jsx";
import NavButton from "./NavButton.jsx";
import { authEnabled, hasSession } from "./auth.js";

// First screen for a device with no identity yet: start a new pairing, or join
// an existing one with a code.
export default function Landing() {
  return (
    <div className="container">
      <div className="brand-row">
        <img className="brand-logo" src="/favicon.svg" alt="" width="44" height="44" />
        <h1>Choices</h1>
      </div>
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
      {/* Signed-in users reach My games via the corner pill; this ghost
          button stays as the guest conversion CTA. */}
      {authEnabled && !hasSession() && (
        <NavButton variant="ghost" href="#/account">
          📜 Sign in for game history
        </NavButton>
      )}

      <IosInstallHint />

      {/* No pairing context here, so tip clicks go unreported (onTip needs a
          claimed seat). */}
      <TipJar compact lead="Free & ad-free, built by one person. ☕ Tip the dev:" />
    </div>
  );
}
