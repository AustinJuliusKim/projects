import React from "react";
import NearMeToggle from "./NearMeToggle.jsx";
import AccountCorner from "./AccountCorner.jsx";

// Contextual back target. account / cancel / admin render above the identity
// gate (main.jsx), so they always get a back (→ their parent; mid-game "#/"
// resolves back to PlayView). Below that gate, an existing identity means
// renderView shows PlayView for ANY remaining hash (#/create, #/join, #/, …) —
// PlayView is a root whose only nav is its own "Leave / switch player", so
// there is no back. Without an identity, create/join can go back to Landing.
export function backTarget(hash, hasIdentity) {
  if (hash.startsWith("#/cancel")) return "#/account";
  if (hash.startsWith("#/account")) return "#/";
  if (hash.startsWith("#/admin")) return "#/";
  if (hasIdentity) return null;
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
export default function TopBar({ hash, hasIdentity }) {
  const back = backTarget(hash, hasIdentity);
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
