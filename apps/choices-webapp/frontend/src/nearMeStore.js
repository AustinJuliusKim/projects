// Session-scoped "near me" state for Places suggestions. The 📍 corner pin
// is the consent surface: browser geolocation is only requested when the
// user taps it (or silently reused when permission was already granted).
// Module-level, not localStorage, on purpose: intent resets each visit so a
// road-trip toggle can't silently stick forever.
import { useSyncExternalStore } from "react";

// enabled = user intent; coords = granted location (null until then).
// Suggestions are location-biased only when both hold.
let state = { enabled: true, coords: null };
const listeners = new Set();

function update(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useNearMe() {
  return useSyncExternalStore(subscribe, () => state);
}

export function disableNearMe() {
  update({ enabled: false });
}

// Ask the browser for location (prompts unless already granted/denied).
// Coords are rounded to ~1km — a 30km bias circle doesn't need house-level
// precision, and rounded values are all that ever leaves the device.
export function requestNearMe() {
  update({ enabled: true });
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      update({
        coords: {
          latitude: Math.round(pos.coords.latitude * 100) / 100,
          longitude: Math.round(pos.coords.longitude * 100) / 100,
        },
      });
    },
    () => {
      /* denied/unavailable -> stays neutral */
    },
    { maximumAge: 600000, timeout: 8000 }
  );
}

// On startup: pick up coords without prompting IF the user already granted
// geolocation to this site before. 'prompt'/'denied' -> do nothing (the pin
// tap is the only thing allowed to trigger the browser prompt).
export function initNearMe() {
  if (!navigator.permissions?.query) return;
  navigator.permissions
    .query({ name: "geolocation" })
    .then((res) => {
      if (res.state === "granted") requestNearMe();
    })
    .catch(() => {});
}
