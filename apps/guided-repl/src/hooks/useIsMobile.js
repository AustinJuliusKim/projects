/**
 * Viewport hook: true when the layout should switch to the mobile shell.
 * Matches the `@media (max-width: 768px)` breakpoint used in styles.css so
 * the JS structural branch and the CSS reflow flip together. SSR-safe
 * (matchMedia guarded) and subscribes to viewport changes.
 */

import { useEffect, useState } from "react";

export const MOBILE_QUERY = "(max-width: 768px)";

/** @returns {boolean} */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    // Sync once in case the query changed between initial state and mount.
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
