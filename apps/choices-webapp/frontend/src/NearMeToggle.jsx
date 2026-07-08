import React from "react";

const PLACES_ENABLED = import.meta.env.VITE_PLACES_ENABLED === "true";

// The 📍 Near me toggle for Places suggestions. On (default): results bias
// to the player's location. Off: name-relevance only — for picking choices
// somewhere you aren't yet (the road-trip case). Session-scoped by design;
// it resets to on so a one-trip toggle can't silently stick forever.
export default function NearMeToggle({ value, onChange }) {
  if (!PLACES_ENABLED) return null;
  return (
    <div className="near-me">
      <button
        type="button"
        className={`chip ${value ? "active" : ""}`}
        aria-pressed={value}
        title={value ? "Suggesting spots near you" : "Suggesting spots anywhere"}
        onClick={() => onChange(!value)}
      >
        📍 Near me
      </button>
    </div>
  );
}
