// Optional Cognito sign-in (hosted UI, OAuth code + PKCE — no SDK).
//
// Accounts are additive: guests never touch this module's network paths.
// Account UI is web-only for v1 (`!isNative`): the Capacitor shell hides
// sign-in like it hides the tip jar (Apple 3.1.1-adjacent caution), and the
// hosted-UI redirect flow needs ASWebAuthenticationSession work anyway.
import { isNative } from "@/lib/platform.js";
import { clearStreak } from "@/lib/streakCache.js";

const DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN || "";
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || "";
const SESSION_KEY = "choices:session";
const VERIFIER_KEY = "choices:pkce";

export const authEnabled = Boolean(DOMAIN && CLIENT_ID) && !isNative;

// The registered redirect URI: site origin + path, no hash (Cognito appends
// ?code=&state= as search params; the SPA's hash routes are unaffected).
function redirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function hasSession() {
  return authEnabled && loadSession() != null;
}

// Signed-in identity claims (sub/email/name) or null.
export function getProfile() {
  return loadSession()?.profile ?? null;
}

export async function signIn() {
  const verifier = randomString(64);
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: "openid email profile",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    identity_provider: "Google", // single IdP: skip the hosted-UI chooser
  });
  window.location.assign(`https://${DOMAIN}/oauth2/authorize?${params}`);
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
  clearStreak();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    logout_uri: redirectUri(),
  });
  window.location.assign(`https://${DOMAIN}/logout?${params}`);
}

// Complete the code exchange if this load is the OAuth redirect. Call once at
// boot, before rendering. Returns true when a sign-in just completed.
export async function handleRedirect() {
  if (!authEnabled) return false;
  const search = new URLSearchParams(window.location.search);
  const code = search.get("code");
  if (!code) return false;

  const stored = JSON.parse(sessionStorage.getItem(VERIFIER_KEY) || "null");
  sessionStorage.removeItem(VERIFIER_KEY);
  // Strip ?code= from the URL either way — it's single-use.
  window.history.replaceState(null, "", redirectUri() + window.location.hash);
  if (!stored || stored.state !== search.get("state")) return false;

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri(),
    code_verifier: stored.verifier,
  });
  storeTokens(tokens);
  return true;
}

// Current ID token, refreshed when within a minute of expiry. Null = guest.
export async function getIdToken() {
  const s = loadSession();
  if (!s) return null;
  if (Date.now() < s.expiresAt - 60_000) return s.idToken;
  try {
    const tokens = await tokenRequest({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: s.refreshToken,
    });
    storeTokens({ ...tokens, refresh_token: s.refreshToken });
    return loadSession().idToken;
  } catch {
    localStorage.removeItem(SESSION_KEY); // refresh revoked/expired: guest
    clearStreak();
    return null;
  }
}

async function tokenRequest(params) {
  const res = await fetch(`https://${DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`token endpoint: ${res.status}`);
  return res.json();
}

function storeTokens(t) {
  saveSession({
    idToken: t.id_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    profile: parseClaims(t.id_token),
  });
}

function parseClaims(jwt) {
  try {
    const payload = JSON.parse(
      atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    return {
      sub: payload.sub,
      email: payload.email ?? null,
      name: payload.name ?? payload.email ?? null,
      // Cognito group memberships (§10c admin flag surface). UI hint only —
      // the real boundary is the server's group-claim check.
      groups: payload["cognito:groups"] ?? [],
    };
  } catch {
    return null;
  }
}

function randomString(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return base64Url(bytes).slice(0, len);
}

function base64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
