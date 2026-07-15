import React from "react";
import NearMeToggle from "./NearMeToggle.jsx";
import AccountCorner from "./AccountCorner.jsx";

// Contextual back target — a pure function of the hash, no identity coupling.
// "#/" already renders PlayView when an identity exists (mid-game) and Landing
// otherwise, so a single "#/" target returns the player to the game *or* the
// landing without the bar knowing anything about identity. Cancel's parent is
// the account screen it's opened from. Landing / PlayView-home are roots.
export function backTarget(hash) {
  if (hash.startsWith("#/cancel")) return "#/account";
  if (hash.startsWith("#/account")) return "#/";
  if (hash.startsWith("#/admin")) return "#/";
  if (hash.startsWith("#/create")) return "#/";
  if (hash.startsWith("#/join")) return "#/";
  return null;
}

// Right-hand tools show on the same set as the old floating corner: everywhere
// except the account / admin / cancel views (which have their own headers).
function showsTools(hash) {
  return (
    !hash.startsWith("#/account") &&
    !hash.startsWith("#/admin") &&
    !hash.startsWith("#/cancel")
  );
}

// Persistent native-style top bar: contextual back on the left, the near-me pin
// + account pill on the right. Replaces the floating corner pills. When both
// tools are hidden (iOS shell: accounts + places off) and there's no back, the
// bar is a transparent spacer over the page bg — visually identical to before.
export default function TopBar({ hash }) {
  const back = backTarget(hash);
  return (
    <div className="topbar">
      <div className="topbar-left">
        {/* Corner-pill family (like .near-me-pin / .account-corner), a plain
            anchor rather than the .btn primitive. The global a:focus-visible
            rule supplies the keyboard ring. */}
        {back && (
          <a className="topbar-back" href={back} aria-label="Back">
            ←
          </a>
        )}
      </div>
      <div className="topbar-right">
        {showsTools(hash) && (
          <>
            <NearMeToggle />
            <AccountCorner />
          </>
        )}
      </div>
    </div>
  );
}
