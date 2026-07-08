import React, { useEffect } from "react";
import { useNearMe, disableNearMe, requestNearMe, initNearMe } from "./nearMeStore.js";

const PLACES_ENABLED = import.meta.env.VITE_PLACES_ENABLED === "true";

// Icon-only 📍 pin in the top corner (rendered next to AccountCorner by
// main.jsx). Lit = suggestions bias to the player's browser location;
// dimmed = neutral (pin off, or location not granted yet). Tapping a dimmed
// pin requests browser geolocation — the tap IS the consent, so the
// permission prompt is never unsolicited. "Near me" arrives as a hover
// tooltip rather than copy.
export default function NearMeToggle() {
  // Same body class AccountCorner sets: it clears the corner row on every
  // view, and the pin can be the only occupant (iOS shell hides accounts).
  useEffect(() => {
    if (!PLACES_ENABLED) return;
    initNearMe();
    document.body.classList.add("account-corner-active");
    return () => document.body.classList.remove("account-corner-active");
  }, []);

  const { enabled, coords } = useNearMe();
  if (!PLACES_ENABLED) return null;

  const active = enabled && coords != null;
  return (
    <button
      type="button"
      className={`near-me-pin ${active ? "" : "off"}`}
      aria-pressed={active}
      aria-label="Near me"
      title="Near me"
      onClick={() => (active ? disableNearMe() : requestNearMe())}
    >
      📍
    </button>
  );
}
