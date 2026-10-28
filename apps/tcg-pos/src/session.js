// Back-office sign-in configuration and token storage (pure; storage and
// clock are passed in so node --test can drive them).

// Which sign-in the build uses:
//   cognito  VITE_COGNITO_DOMAIN + VITE_COGNITO_CLIENT_ID set (and
//            VITE_AUTH_MODE isn't "dev")
//   dev      dev builds only: VITE_AUTH_MODE=dev, or no Cognito env
//   error    a production build without Cognito env (or asking for dev
//            login) — the app refuses to start rather than show a dev
//            login form that the production API doesn't have.
export function authConfig(env = {}) {
  const domain = (env.VITE_COGNITO_DOMAIN || "").trim();
  const clientId = (env.VITE_COGNITO_CLIENT_ID || "").trim();
  const wantsDev = (env.VITE_AUTH_MODE || "").trim().toLowerCase() === "dev";
  const hasCognito = Boolean(domain && clientId);
  const prod = Boolean(env.PROD);
  if (prod && (wantsDev || !hasCognito)) {
    return {
      mode: "error",
      error: wantsDev
        ? "This is a production build with VITE_AUTH_MODE=dev. Dev login is for local development only."
        : "Sign-in isn't configured: set VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID at build time.",
    };
  }
  if (wantsDev || !hasCognito) return { mode: "dev" };
  return {
    mode: "cognito",
    domain,
    clientId,
    redirectPath: env.VITE_COGNITO_REDIRECT_PATH || "/auth/callback",
  };
}

export const SESSION_KEY = "tcgpos:session";
export const PKCE_KEY = "tcgpos:pkce";
export const STORE_KEY = "tcgpos:store";
export const LOCATION_KEY = "tcgpos:location";
export const INVITE_KEY = "tcgpos:invite";
export const DEVICE_KEY = "tcgpos:device";
export const REGISTER_SESSION_KEY = "tcgpos:register-session";
export const SURFACE_KEY = "tcgpos:surface";

// Refresh (or sign out) this long before the access token actually expires,
// so a request never leaves with a token that dies in flight.
export const EXPIRY_SKEW_MS = 60_000;

// A stored session from a token response (Cognito /oauth2/token or
// POST /v1/dev/login). `previous` keeps the refresh token across a refresh
// (Cognito doesn't return a new one).
export function sessionFromTokens(t, { mode, now = Date.now(), previous = null } = {}) {
  if (!t || !t.access_token) throw new Error("token response has no access_token");
  return {
    mode,
    accessToken: t.access_token,
    idToken: t.id_token || (previous && previous.idToken) || null,
    refreshToken: t.refresh_token || (previous && previous.refreshToken) || null,
    expiresAt: now + (Number(t.expires_in) || 3600) * 1000,
  };
}

// fresh | refresh (expired-ish, but a refresh token can renew it) | expired
export function sessionStatus(s, now = Date.now()) {
  if (!s || !s.accessToken) return "expired";
  if (now < s.expiresAt - EXPIRY_SKEW_MS) return "fresh";
  return s.refreshToken && s.mode === "cognito" ? "refresh" : "expired";
}

// JSON in a Storage, tolerant of a missing/blocked storage and bad JSON.
export function readJson(storage, key) {
  try {
    const raw = storage && storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage, key, value) {
  try {
    if (!storage) return;
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the app still works for this page load
  }
}

// A JWT's claims, unverified (display only; the API verifies tokens).
export function jwtClaims(jwt) {
  try {
    const part = String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
  } catch {
    return null;
  }
}
