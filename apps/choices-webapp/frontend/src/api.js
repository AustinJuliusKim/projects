// Thin fetch wrappers around the game API (Function URL or CloudFront /api).
import { getIdToken, getProfile } from "./auth.js";
import { writeStreak } from "./streakCache.js";

const API_URL = import.meta.env.VITE_API_URL;

// Optional account identity: {} for guests, authorization header when a
// session exists. Only attached where the backend uses it (claimSeat, getMe,
// rematch's premium bypass) so game polling never grows an auth dependency.
async function authHeaders() {
  const idToken = await getIdToken();
  return idToken ? { authorization: `Bearer ${idToken}` } : {};
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toError(status, data) {
  const err = new Error(data.error || `Request failed (${status})`);
  err.code = data.code;
  err.status = status;
  return err;
}

async function post(action, payload, headers = {}) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (err) {
    // Enum-only ops beacon (never the message). Guarded so a failing track
    // can never track itself.
    if (action !== "track") track("client_error", { error_type: "api_network" });
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status >= 500 && action !== "track") {
      track("client_error", { error_type: "api_5xx" });
    }
    throw toError(res.status, data);
  }
  return data;
}

// --- Analytics beacons (event lake `track` action) ---
//
// Fire-and-forget and enum-only by contract: payloads may carry nothing but
// enumerated strings and bounded ints (the server drops anything else with
// a silent 200) — never typed text, never the join code outside `opts.code`
// for the two join-flow events (the server resolves it to a pairing_ref and
// drops it). opts: { pairingId, role, token } for pairing-scoped types,
// { code } for invite_link_opened / join_abandoned.
export function track(type, payload = {}, opts = {}) {
  if (!API_URL) return;
  post("track", { type, payload, ...opts }).catch(() => {});
}

// pagehide-safe variant: sendBeacon survives page teardown where fetch gets
// cancelled. Sent as text/plain (a CORS-simple type, so no preflight that
// sendBeacon can't perform); the server parses the body regardless.
export function trackBeacon(type, payload = {}, opts = {}) {
  if (!API_URL) return;
  const body = JSON.stringify({ action: "track", type, payload, ...opts });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(API_URL, new Blob([body], { type: "text/plain" }));
  } else {
    track(type, payload, opts);
  }
}

// Mutations carry an actionId and are idempotent server-side (duplicate
// requests replay the stored result), so retrying on network errors / 429 /
// 5xx can never double-apply a move. Other 4xx (409 turn conflicts etc.) are
// real answers — never retried.
async function mutate(action, payload, headers = {}) {
  if (!API_URL) throw new Error("VITE_API_URL is not configured");
  const actionId = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      return await post(action, { ...payload, actionId }, headers);
    } catch (err) {
      const retryable = err.status == null || RETRYABLE.has(err.status);
      if (!retryable || attempt >= 2) throw err;
      await sleep(Math.random() * 400 * 2 ** attempt); // full jitter
    }
  }
}

// source ("manual" | "fill4") feeds the game_created event's provenance;
// omitted = manual.
export const createPairing = (choices, source) =>
  post("createPairing", { choices, ...(source ? { source } : {}) });
// Signed-in claims link the seat to the account (history/streaks accrue).
export const claimSeat = async (code, seat) =>
  post("claimSeat", { code, seat }, await authHeaders());
// Write-through to the streak cache so the corner affordance stays fresh
// without ever fetching on its own.
export const getMe = async () => {
  const data = await post("getMe", {}, await authHeaders());
  const premium = ["active", "past_due"].includes(data.premium?.status);
  writeStreak(getProfile()?.sub, data.stats, premium);
  return data;
};
// Owner-only activity dashboard. Auth header required; the backend gates on
// ADMIN_SUBS and returns anonymous aggregates only. No retry — the poll is it.
export const getAdminOverview = async () =>
  post("getAdminOverview", {}, await authHeaders());
export const createCheckoutSession = async (plan) =>
  post("createCheckoutSession", { plan }, await authHeaders());
export const createPortalSession = async () =>
  post("createPortalSession", {}, await authHeaders());
// In-app "Cancel subscription" (the Choicey page): cancels at period end.
export const cancelSubscription = async () =>
  post("cancelSubscription", {}, await authHeaders());
// Owner-only premium backfill (AdminView). Defaults to the caller's own
// account; reconciles the real Stripe customer/sub by email when live.
export const adminSetPremium = async (payload = {}) =>
  post("adminSetPremium", payload, await authHeaders());
// GET so CloudFront can edge-cache game state (POSTs are never cached). No
// retry loop: the poll itself is the retry.
export async function getState(pairingId, role, token) {
  if (!API_URL) throw new Error("VITE_API_URL is not configured");
  const qs = new URLSearchParams({ action: "getState", pairingId, role, token });
  const res = await fetch(`${API_URL}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(res.status, data);
  return data;
}
export const eliminate = (pairingId, role, token, gameNumber, index) =>
  mutate("eliminate", { pairingId, role, token, gameNumber, index });
// Auth header rides along so a signed-in premium player can start out of turn.
export const rematch = async (pairingId, role, token, choices, source) =>
  mutate("rematch", { pairingId, role, token, choices, ...(source ? { source } : {}) }, await authHeaders());
export const subscribe = (pairingId, role, token, subscription) =>
  post("subscribe", { pairingId, role, token, subscription });
export const linkClick = (pairingId, role, token, gameNumber, platform) =>
  mutate("linkClick", { pairingId, role, token, gameNumber, platform });
// Suggestion lookups are best-effort plain posts — no retry wrapper (a lost
// suggestion request is fine; the next keystroke is the retry).
export const getPairHistory = (pairingId, role, token) =>
  post("getPairHistory", { pairingId, role, token });
// geo ({latitude, longitude}, pre-rounded by nearMeStore) rides along only
// while the 📍 pin is lit; absent = neutral suggestions.
// Places is premium-gated server-side (real per-use Google cost), so the auth
// header rides along to identify the account; guests/free get empty results
// with premiumRequired: true.
export const placesSuggest = async (input, sessionToken, geo = null) =>
  post("placesSuggest", { input, sessionToken, ...(geo ? { geo } : {}) }, await authHeaders());
export const placeDetails = async (placeId, sessionToken) =>
  post("placeDetails", { placeId, sessionToken }, await authHeaders());
// "Fill my 4": with a pairing (rematch) the seat token authorizes and the
// counter lives on the pairing; without one (create screen) the auth header
// identifies the account the counter lives on.
export const fillMyFour = async ({ pairingId, role, token, occasion }) =>
  mutate("fillMyFour", { pairingId, role, token, occasion }, await authHeaders());
