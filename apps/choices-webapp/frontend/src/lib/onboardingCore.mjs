// Pure decision logic for the first-run onboarding overlay. Zero imports so
// `node --test` can run it directly (the `@` alias only resolves under vite) —
// same split as flagsCore.mjs; the React side lives in features/onboarding/.

export const ONBOARDING_KEY = "choices:onboarded";
export const ONBOARDING_VERSION = 1;

// Stored record: { v, at, variant: "full" | "condensed" | "synced" }. Any
// well-formed record counts as onboarded — including unknown future `v`
// values, so a redesigned tour can never re-nag existing users. `v` exists
// for migrations only.
export function parseOnboarding(raw) {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
    if (typeof rec.at !== "number") return null;
    return rec;
  } catch {
    return null;
  }
}

export function serializeOnboarding(variant, now = Date.now()) {
  return JSON.stringify({ v: ONBOARDING_VERSION, at: now, variant });
}

// Which onboarding surface a location warrants:
//   "full"      — the multi-step carousel (organic landing)
//   "condensed" — the one-tap concept card (arrived via a join link/code)
//   null        — none
// Order matters: an active game identity always wins (with one, renderView()
// shows PlayView for *every* hash — never overlay a live game), and deep
// links to any other screen mean the user is already intent-loaded.
export function onboardingSurface(hash, hasIdentity) {
  if (hasIdentity) return null;
  if (/^#\/join/.test(hash)) return "condensed";
  if (hash === "" || hash === "#" || hash === "#/") return "full";
  return null;
}

// The mount decision. "wait" renders nothing (yet): before flag hydration
// (the flag defaults off, so an enabled override must not flash in late), and
// while a signed-in user's server record is in flight (a new device must not
// flash the carousel and yank it). Guests resolve synchronously — no network
// wait. serverOnboarded: undefined = in flight, null = fetch failed
// (fail-open to showing), boolean = the USER# record's answer.
export function decideOnboarding({
  surface,
  record,
  flagOn,
  hydrated,
  signedIn,
  serverOnboarded,
}) {
  if (!flagOn) return "hide";
  if (!hydrated) return "wait";
  if (surface == null) return "hide";
  if (record != null) return "hide"; // local wins — synchronous, no flash
  if (!signedIn) return "show";
  if (serverOnboarded === undefined) return "wait";
  if (serverOnboarded === true) return "hide";
  return "show";
}
