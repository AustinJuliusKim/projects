// Cognito hosted UI, OAuth authorization code + PKCE (S256), no SDK.
// Adapted from apps/choices-webapp/frontend/src/lib/auth.js; split so every
// piece that isn't a redirect or a fetch is a pure, tested function.
// Uses Web Crypto (globalThis.crypto), so it runs in browsers and Node ≥ 20.

export const SCOPES = "openid email profile";

export function base64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// URL-safe random string of exactly `len` characters (43–128 for a verifier).
export function randomString(len, cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(len));
  return base64Url(bytes).slice(0, len);
}

export async function challengeFor(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

// { verifier, challenge, state } for one sign-in attempt.
export async function createPkce(cryptoImpl = globalThis.crypto) {
  const verifier = randomString(64, cryptoImpl);
  return {
    verifier,
    challenge: await challengeFor(verifier, cryptoImpl),
    state: randomString(24, cryptoImpl),
  };
}

// The hosted-UI base URL from VITE_COGNITO_DOMAIN, which may be the stack's
// HostedUiDomain output (https://x.auth.region.amazoncognito.com) or a bare
// host name.
export function cognitoBase(domain) {
  const d = String(domain || "").trim().replace(/\/+$/, "");
  if (!d) return "";
  return /^https?:\/\//.test(d) ? d : `https://${d}`;
}

export function authorizeUrl({ domain, clientId, redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${cognitoBase(domain)}/oauth2/authorize?${params}`;
}

export function logoutUrl({ domain, clientId, logoutUri }) {
  const params = new URLSearchParams({ client_id: clientId, logout_uri: logoutUri });
  return `${cognitoBase(domain)}/logout?${params}`;
}

export function codeExchangeParams({ clientId, code, redirectUri, verifier }) {
  return {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
}

export function refreshParams({ clientId, refreshToken }) {
  return { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken };
}

// Validate the redirect back from the hosted UI against what signIn stored.
// Returns { code } or { error }. `stored` is { verifier, state } or null.
export function checkCallback(search, stored) {
  const q = new URLSearchParams(search);
  if (q.get("error")) {
    return { error: q.get("error_description") || q.get("error") };
  }
  const code = q.get("code");
  if (!code) return { error: "the sign-in response had no code" };
  if (!stored || !stored.state || stored.state !== q.get("state")) {
    return { error: "the sign-in response didn't match this browser's request; try again" };
  }
  return { code };
}

export async function tokenRequest(domain, params, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${cognitoBase(domain)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`sign-in failed: ${body.error || res.status}`);
  }
  return res.json();
}
