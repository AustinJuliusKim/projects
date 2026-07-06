import React from "react";
import IosInstallHint from "./IosInstallHint.jsx";
import TipJar from "./support.jsx";
import { authEnabled, hasSession } from "./auth.js";

// First screen for a device with no identity yet: start a new pairing, or join
// an existing one with a code.
export default function Landing() {
  return (
    <div className="container">
      <h1>Choices</h1>
      <p className="muted">
        A two-player game: pick 4 options, take turns cutting, last one wins.
      </p>

      <a className="btn primary" href="#/create">
        ➕ Start a new game
      </a>
      <a className="btn" href="#/join">
        🔑 Enter a game code
      </a>
      {/* Signed-in users reach My games via the corner pill; this ghost
          button stays as the guest conversion CTA. */}
      {authEnabled && !hasSession() && (
        <a className="btn ghost" href="#/account">
          📜 Sign in for game history
        </a>
      )}

      <IosInstallHint />

      {/* No pairing context here, so tip clicks go unreported (onTip needs a
          claimed seat). */}
      <TipJar compact lead="Free & ad-free, built by one person. ☕ Tip the dev:" />
    </div>
  );
}
