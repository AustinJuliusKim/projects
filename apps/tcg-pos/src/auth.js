// Back-office sign-in flows. Each takes its side effects (storage, fetch,
// the API calls) as arguments so node --test can run them end to end.
//
//   Cognito  beginCognitoSignIn → hosted UI → /auth/callback?code&state →
//            completeCognitoSignIn (code + PKCE verifier → tokens) →
//            POST /v1/me/identity {id_token} (sets email + name; Cognito
//            access tokens carry neither)
//   dev      POST /v1/dev/login {email, name} → the same identity call
//
// Both return { session, me }: the stored tokens and the /v1/me body that
// /v1/me/identity answers with.

import {
  authorizeUrl,
  checkCallback,
  codeExchangeParams,
  createPkce,
  logoutUrl,
  refreshParams,
  revokeToken,
  tokenRequest,
} from "./pkce.js";
import { PKCE_KEY, readJson, SESSION_KEY, sessionFromTokens, sessionStatus, writeJson } from "./session.js";

export function redirectUri(config, origin) {
  return `${origin}${config.redirectPath}`;
}

// Stores the verifier + state for this tab and returns the hosted-UI URL.
// forceLogin (an enrolled register): the hosted UI must ask for a password
// even if it still has a session cookie from whoever signed in before.
export async function beginCognitoSignIn(config, { origin, sessionStore, cryptoImpl, forceLogin = false }) {
  const pkce = await createPkce(cryptoImpl);
  writeJson(sessionStore, PKCE_KEY, { verifier: pkce.verifier, state: pkce.state });
  return authorizeUrl({
    domain: config.domain,
    clientId: config.clientId,
    redirectUri: redirectUri(config, origin),
    challenge: pkce.challenge,
    state: pkce.state,
    prompt: forceLogin ? "login" : undefined,
  });
}

export async function completeCognitoSignIn(
  config,
  search,
  { origin, sessionStore, fetchImpl, syncIdentity, now = Date.now() },
) {
  const stored = readJson(sessionStore, PKCE_KEY);
  writeJson(sessionStore, PKCE_KEY, null); // single use, whatever happens
  const checked = checkCallback(search, stored);
  if (checked.error) throw new Error(checked.error);
  const tokens = await tokenRequest(
    config.domain,
    codeExchangeParams({
      clientId: config.clientId,
      code: checked.code,
      redirectUri: redirectUri(config, origin),
      verifier: stored.verifier,
    }),
    fetchImpl,
  );
  const session = sessionFromTokens(tokens, { mode: "cognito", now });
  const me = await syncIdentity(session.accessToken, session.idToken);
  return { session, me };
}

export async function devSignIn(email, name, { devLogin, syncIdentity, now = Date.now() }) {
  const cleanEmail = String(email || "").trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(cleanEmail)) throw new Error("Enter an email address.");
  const tokens = await devLogin(cleanEmail, String(name || "").trim() || undefined);
  const session = sessionFromTokens(tokens, { mode: "dev", now });
  const me = await syncIdentity(session.accessToken, session.idToken);
  return { session, me };
}

// The session to send now: unchanged if fresh, refreshed through Cognito's
// refresh_token grant if it's about to expire, or null (signed out) if it
// can't be renewed.
export async function ensureFresh(session, config, { fetchImpl, now = Date.now() } = {}) {
  const status = sessionStatus(session, now);
  if (status === "fresh") return session;
  if (status === "expired") return null;
  try {
    const tokens = await tokenRequest(
      config.domain,
      refreshParams({ clientId: config.clientId, refreshToken: session.refreshToken }),
      fetchImpl,
    );
    return sessionFromTokens(tokens, { mode: "cognito", now, previous: session });
  } catch {
    return null;
  }
}

// Where to send the browser on sign-out: the hosted UI's logout (ends the
// Cognito session too) or nowhere for dev login.
export function signOutUrl(config, session, origin) {
  if (config.mode !== "cognito" || !session || session.mode !== "cognito") return null;
  return logoutUrl({ domain: config.domain, clientId: config.clientId, logoutUri: `${origin}/` });
}

// End the back-office session on this browser, e.g. because it was just
// enrolled as a register: drop it from storage, and (Cognito) revoke its
// refresh token, best effort — a failed revoke still leaves the browser
// signed out, and the access token dies within the hour. Returns the
// hosted-UI logout URL to visit (clears Cognito's own session cookie), or
// null for dev login.
export async function endBackOfficeSession(config, session, { storage, origin, fetchImpl } = {}) {
  writeJson(storage, SESSION_KEY, null);
  if (config.mode === "cognito" && session && session.mode === "cognito" && session.refreshToken) {
    try {
      await revokeToken(config.domain, { clientId: config.clientId, token: session.refreshToken }, fetchImpl);
    } catch {
      // best effort
    }
  }
  return origin ? signOutUrl(config, session, origin) : null;
}

// An invite link (/invite?token=...) as a token to keep until signed in.
export function inviteTokenFrom(pathname, search) {
  if (!/^\/invite\/?$/.test(pathname || "")) return null;
  const token = new URLSearchParams(search).get("token");
  return token && token.trim().length >= 16 ? token.trim() : null;
}
