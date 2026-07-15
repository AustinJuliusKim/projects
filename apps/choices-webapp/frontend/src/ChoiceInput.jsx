import React, { useEffect, useRef, useState } from "react";
import { placesSuggest, placeDetails, track } from "./api.js";
import { rankSuggestions, suggestionLayersToReport } from "./suggest.js";
import { useNearMe } from "./nearMeStore.js";
import { getProfile } from "./auth.js";
import { readStreak } from "./streakCache.js";

// Places layer (L3) is stack-config-gated: blank means the client never
// calls the proxy at all and this renders exactly like the plain input.
const PLACES_ENABLED = import.meta.env.VITE_PLACES_ENABLED === "true";
const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

// Drop-in replacement for the raw choice <input> with a typeahead dropdown.
// L1 = pairEntries (pair memory, passed by the rematch form); L3 = Places
// Autocomplete via our Lambda proxy — debounced, one session token per input
// focus, terminated by placeDetails on selection (that's what closes the
// billing session).
// trackOpts ({ pairingId, role, token }) scopes suggestion beacons to the
// pairing when one exists (rematch form); absent on the create screen.
export default function ChoiceInput({ value, onChange, placeholder, pairEntries = [], trackOpts = null }) {
  const [placesResults, setPlacesResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const sessionRef = useRef(null);
  const seqRef = useRef(0); // drops out-of-order responses
  // Corner 📍 pin state: coords ride along only while the pin is lit.
  const { enabled: nearMe, coords } = useNearMe();
  const geo = nearMe ? coords : null;
  // Places (L3) is premium-gated server-side; skip the proxy call for
  // non-premium so we never spend a Lambda round-trip on an empty result.
  // Pair-memory (L1) suggestions below stay available to everyone.
  const premium = !!readStreak(getProfile()?.sub)?.premium;

  const suggestions = open
    ? rankSuggestions(value, pairEntries, placesResults)
    : [];

  // suggestion_shown: {layer, count} only — never the typed query. The
  // helper self-dedupes to once per layer per session, so re-renders no-op.
  useEffect(() => {
    for (const { layer, count } of suggestionLayersToReport(suggestions)) {
      track("suggestion_shown", { layer, count }, trackOpts ?? {});
    }
  }, [suggestions, trackOpts]);

  useEffect(() => {
    if (!PLACES_ENABLED || !open || !premium) return;
    const q = value.trim();
    if (q.length < MIN_QUERY) {
      setPlacesResults([]);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await placesSuggest(q, sessionRef.current, geo);
        if (seq === seqRef.current) setPlacesResults(res.suggestions ?? []);
      } catch {
        /* suggestions are best-effort */
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, open, geo]);

  function onFocus() {
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
    setOpen(true);
  }

  function select(s) {
    // suggestion_accepted carries the layer only (pairing-scoped in the
    // catalog, so it's sent only when a pairing context exists).
    if (trackOpts?.pairingId) {
      track("suggestion_accepted", { layer: s.source }, trackOpts);
    }
    onChange(s.label);
    setOpen(false);
    setHighlight(-1);
    setPlacesResults([]);
    if (s.placeId) {
      // Fire-and-forget: terminates the Places session; result unused (v1
      // keeps choices as plain text — no placeId persisted).
      placeDetails(s.placeId, sessionRef.current).catch(() => {});
      sessionRef.current = null;
    }
  }

  function onKeyDown(e) {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      select(suggestions[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="choice-input-wrap">
      <input
        className="choice-input"
        value={value}
        placeholder={placeholder}
        maxLength={60}
        onChange={(e) => {
          setHighlight(-1);
          onChange(e.target.value);
        }}
        onFocus={onFocus}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                className={`suggestion ${i === highlight ? "active" : ""}`}
                onMouseDown={(e) => e.preventDefault() /* keep input focus */}
                onClick={() => select(s)}
              >
                <span className="suggestion-label">{s.label}</span>
                {s.source === "pair" && <span className="tag">again?</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
