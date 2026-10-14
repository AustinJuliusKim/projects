import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { applySeo, canonicalHref } from "./seo.js";

// Per-route title, meta description and canonical link. `keep` lists the
// query params that belong in the canonical URL.
export function useSeo({ title, description, keep = [], noindex = false }) {
  const { pathname, search } = useLocation();
  const keepKey = keep.join(",");
  useEffect(() => {
    applySeo({
      title,
      description,
      canonical: canonicalHref(window.location.origin, pathname, search, keepKey ? keepKey.split(",") : []),
      noindex,
    });
  }, [title, description, pathname, search, keepKey, noindex]);
}
