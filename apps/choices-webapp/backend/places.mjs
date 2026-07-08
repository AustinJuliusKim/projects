// Server-side proxy for Google Places API (New) — suggestion engine L3.
// The API key never reaches the client. Both calls are best-effort: any
// upstream trouble (timeout, quota, 4xx) degrades to empty results rather
// than a 5xx — suggestions must never break typing.
//
// Billing shape (why placeDetails exists at all): autocomplete keystrokes
// sharing a session token are free until the session terminates with a
// Place Details call — details() uses the Essentials-tier field mask to
// keep that termination cheap.

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places/";
const TIMEOUT_MS = 2000;
const MAX_SUGGESTIONS = 5;

let placesFetch = (...args) => fetch(...args);

export function placesEnabled() {
  return Boolean(process.env.PLACES_API_KEY);
}

// Soft bias circle around the viewer's location (browser geolocation,
// rounded client-side). Bias, not restriction — a strong-name query still
// wins over distance.
const BIAS_RADIUS_METERS = 30000;

// Neutral bias: an explicit world-spanning rectangle. OMITTING locationBias
// would not be neutral — Google then IP-biases the caller, i.e. the Lambda's
// region. The world rect overrides that and ranks purely by name
// relevance/prominence.
const WORLD_BIAS = {
  rectangle: {
    low: { latitude: -90, longitude: -180 },
    high: { latitude: 90, longitude: 180 },
  },
};

// geo: { latitude, longitude } -> 30km circle; anything else -> world rect
// (📍 pin off, permission not granted, or an old client).
function locationBias(geo) {
  if (geo) {
    return {
      locationBias: { circle: { center: geo, radius: BIAS_RADIUS_METERS } },
    };
  }
  return { locationBias: WORLD_BIAS };
}

// -> { suggestions: [{ text, placeId }], enabled }
export async function autocomplete(input, sessionToken, geo) {
  if (!placesEnabled()) return { suggestions: [], enabled: false };
  try {
    const res = await withTimeout((signal) =>
      placesFetch(AUTOCOMPLETE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": process.env.PLACES_API_KEY,
        },
        body: JSON.stringify({
          input,
          sessionToken,
          includedPrimaryTypes: ["restaurant"],
          ...locationBias(geo),
        }),
        signal,
      })
    );
    if (!res.ok) throw new Error(`autocomplete status ${res.status}`);
    const data = await res.json();
    const suggestions = (data.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .slice(0, MAX_SUGGESTIONS)
      .map((p) => ({
        text: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        placeId: p.placeId,
      }))
      .filter((s) => s.text && s.placeId);
    return { suggestions, enabled: true };
  } catch (err) {
    console.error("places autocomplete failed", err);
    return { suggestions: [], enabled: true };
  }
}

// Terminate the autocomplete session on selection. -> { place, enabled }
export async function details(placeId, sessionToken) {
  if (!placesEnabled()) return { place: null, enabled: false };
  try {
    const qs = sessionToken
      ? `?sessionToken=${encodeURIComponent(sessionToken)}`
      : "";
    const res = await withTimeout((signal) =>
      placesFetch(`${DETAILS_URL}${encodeURIComponent(placeId)}${qs}`, {
        headers: {
          "X-Goog-Api-Key": process.env.PLACES_API_KEY,
          "X-Goog-FieldMask": "id,displayName,formattedAddress",
        },
        signal,
      })
    );
    if (!res.ok) throw new Error(`details status ${res.status}`);
    const data = await res.json();
    return {
      place: {
        id: data.id,
        name: data.displayName?.text ?? "",
        address: data.formattedAddress ?? "",
      },
      enabled: true,
    };
  } catch (err) {
    console.error("places details failed", err);
    return { place: null, enabled: true };
  }
}

async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Test hook (same rationale as auth.mjs's _setVerifierForTests).
export function _setPlacesFetchForTests(fake) {
  placesFetch = fake ?? ((...args) => fetch(...args));
}
