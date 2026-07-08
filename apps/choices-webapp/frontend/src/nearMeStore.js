// Session-scoped "near me" preference for Places suggestions. Lives at
// module level (not localStorage) on purpose: it resets to on each visit so
// a road-trip toggle can't silently stick forever. The corner pin
// (NearMeToggle) writes it; the choice-input forms read it.
import { useSyncExternalStore } from "react";

let value = true;
const listeners = new Set();

export function setNearMe(next) {
  value = next;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useNearMe() {
  return useSyncExternalStore(subscribe, () => value);
}
