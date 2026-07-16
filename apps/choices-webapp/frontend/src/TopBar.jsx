import React from "react";
import NearMeToggle from "./NearMeToggle.jsx";
import { activeTab } from "./BottomNav.jsx";

// Contextual back target. cancel / admin are secondary screens reached from
// a tab, so they always get a back to that tab. The tab roots themselves
// (history/premium/settings/home) have no back — the bottom nav is the nav.
// Below that, an existing identity means renderView shows PlayView for ANY
// remaining hash (#/create, #/join, #/, …) — PlayView is a root whose only
// nav is its own "Leave / switch player", so there is no back. Without an
// identity, create/join can go back to Landing.
export function backTarget(hash, hasIdentity) {
  if (hash.startsWith("#/cancel")) return "#/premium";
  if (hash.startsWith("#/admin")) return "#/settings";
  if (hash.startsWith("#/history") || hash.startsWith("#/premium") || hash.startsWith("#/settings")) {
    return null;
  }
  if (hasIdentity) return null;
  if (hash.startsWith("#/create")) return "#/";
  if (hash.startsWith("#/join")) return "#/";
  return null;
}

// Right-hand tools (the 📍 near-me pin) show only on game screens (the Home
// tab), which is where location-biased suggestions actually happen.
function showsTools(hash) {
  return activeTab(hash) === "home";
}

// Persistent native-style top bar: contextual back on the left, the near-me
// pin on the right. The account pill has moved to the bottom nav's History
// tab. When both are hidden and there's no back, the bar is a transparent
// spacer over the page bg.
export default function TopBar({ hash, hasIdentity }) {
  const back = backTarget(hash, hasIdentity);
  return (
    <div className="topbar">
      <div className="topbar-left">
        {/* Corner-pill family (like .near-me-pin), a plain anchor rather
            than the .btn primitive. The global a:focus-visible rule
            supplies the keyboard ring. */}
        {back && (
          <a className="topbar-back" href={back} aria-label="Back">
            ←
          </a>
        )}
      </div>
      <div className="topbar-right">{showsTools(hash) && <NearMeToggle />}</div>
    </div>
  );
}
