import React, { useEffect } from "react";
import { useNearMe, setNearMe } from "./nearMeStore.js";

const PLACES_ENABLED = import.meta.env.VITE_PLACES_ENABLED === "true";

// Icon-only 📍 pin in the top corner (rendered next to AccountCorner by
// main.jsx). On (default): Places suggestions bias to the player's location.
// Off: name-relevance only — for picking choices somewhere you aren't yet
// (the road-trip case). Dimmed when off; "Near me" arrives as a hover
// tooltip (title) rather than copy.
export default function NearMeToggle() {
  // Same body class AccountCorner sets: it clears the corner row on every
  // view, and the pin can be the only occupant (iOS shell hides accounts).
  useEffect(() => {
    if (!PLACES_ENABLED) return;
    document.body.classList.add("account-corner-active");
    return () => document.body.classList.remove("account-corner-active");
  }, []);

  const nearMe = useNearMe();
  if (!PLACES_ENABLED) return null;

  return (
    <button
      type="button"
      className={`near-me-pin ${nearMe ? "" : "off"}`}
      aria-pressed={nearMe}
      aria-label="Near me"
      title="Near me"
      onClick={() => setNearMe(!nearMe)}
    >
      📍
    </button>
  );
}
