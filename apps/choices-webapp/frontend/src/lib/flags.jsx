import React, { createContext, useContext, useEffect, useState } from "react";
import { getFlags } from "@/lib/api.js";
import {
  initialFlagsState,
  hydrateFlagsState,
  resolveFlag,
} from "@/lib/flagsCore.mjs";

// FlagsProvider (§10c): one getFlags fetch at app load (browser-cached 60s).
// Children render immediately with the built-in defaults and re-render once
// hydrated — the fetch never blocks first paint, and a failed fetch simply
// leaves the defaults in place.
const FlagsContext = createContext(initialFlagsState());

export function FlagsProvider({ children }) {
  const [state, setState] = useState(initialFlagsState);
  useEffect(() => {
    let alive = true;
    getFlags()
      .then((res) => {
        if (alive) setState((s) => hydrateFlagsState(s, res?.flags));
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, hydrated: true }));
      });
    return () => {
      alive = false;
    };
  }, []);
  return <FlagsContext.Provider value={state}>{children}</FlagsContext.Provider>;
}

// useFlag("release_x", fallback): current effective value; re-renders on
// hydration. Safe outside the provider (context default = defaults).
export function useFlag(name, fallback) {
  return resolveFlag(useContext(FlagsContext), name, fallback);
}
