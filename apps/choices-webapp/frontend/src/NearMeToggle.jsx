import React, { useEffect } from "react";
import { useNearMe, disableNearMe, requestNearMe, initNearMe } from "./nearMeStore.js";
import { getProfile } from "./auth.js";
import { readStreak } from "./streakCache.js";

const PLACES_ENABLED = import.meta.env.VITE_PLACES_ENABLED === "true";

// Icon-only 📍 pin in the top bar, shown on game screens only (TopBar.jsx).
// Lit = suggestions bias to the player's browser location;
// dimmed = neutral (pin off, or location not granted yet). Tapping a dimmed
// pin requests browser geolocation — the tap IS the consent, so the
// permission prompt is never unsolicited. "Near me" arrives as a hover
// tooltip rather than copy.
export default function NearMeToggle() {
  useEffect(() => {
    if (!PLACES_ENABLED) return;
    initNearMe();
  }, []);

  const { enabled, coords } = useNearMe();
  if (!PLACES_ENABLED) return null;

  // Near-me suggestions are premium-gated server-side (Places has real cost).
  // For non-premium, the pin is a locked upsell: tapping routes to the account
  // screen instead of firing an unsolicited geolocation prompt.
  const premium = !!readStreak(getProfile()?.sub)?.premium;
  if (!premium) {
    return (
      <button
        type="button"
        className="near-me-pin off locked"
        aria-label="Near me (Premium)"
        title="Near me — Premium"
        onClick={() => {
          window.location.hash = "#/premium";
        }}
      >
        📍
      </button>
    );
  }

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
