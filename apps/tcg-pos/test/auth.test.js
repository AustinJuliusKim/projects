import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginCognitoSignIn,
  completeCognitoSignIn,
  devSignIn,
  endBackOfficeSession,
  ensureFresh,
  inviteTokenFrom,
  redirectUri,
  signOutUrl,
} from "../src/auth.js";
import { challengeFor } from "../src/pkce.js";
import { PKCE_KEY, readJson, SESSION_KEY, writeJson } from "../src/session.js";

const CONFIG = { mode: "cognito", domain: "auth.example.com", clientId: "cid", redirectPath: "/auth/callback" };
const ORIGIN = "http://localhost:5173";

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("Cognito sign-in: authorize URL, then code + verifier exchange, then identity", async () => {
  const sessionStore = memoryStorage();
  const url = new URL(await beginCognitoSignIn(CONFIG, { origin: ORIGIN, sessionStore }));
  const stored = readJson(sessionStore, PKCE_KEY);
  assert.equal(url.searchParams.get("state"), stored.state);
  assert.equal(url.searchParams.get("code_challenge"), await challengeFor(stored.verifier));
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri(CONFIG, ORIGIN));

  let tokenBody;
  const fetchImpl = async (u, init) => {
    tokenBody = new URLSearchParams(init.body);
    return {
      ok: true,
      json: async () => ({ access_token: "acc", id_token: "idt", refresh_token: "ref", expires_in: 3600 }),
    };
  };
  let synced;
  const syncIdentity = async (access, id) => {
    synced = [access, id];
    return { user: { id: "u1" }, stores: [] };
  };
  const out = await completeCognitoSignIn(CONFIG, `?code=c0de&state=${stored.state}`, {
    origin: ORIGIN,
    sessionStore,
    fetchImpl,
    syncIdentity,
    now: 0,
  });
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("code"), "c0de");
  assert.equal(tokenBody.get("code_verifier"), stored.verifier);
  assert.equal(tokenBody.get("redirect_uri"), "http://localhost:5173/auth/callback");
  assert.deepEqual(synced, ["acc", "idt"]);
  assert.equal(out.session.refreshToken, "ref");
  assert.equal(out.session.mode, "cognito");
  assert.deepEqual(out.me.stores, []);
  // The verifier is single use.
  assert.equal(readJson(sessionStore, PKCE_KEY), null);
  await assert.rejects(
    completeCognitoSignIn(CONFIG, `?code=c0de&state=${stored.state}`, { origin: ORIGIN, sessionStore }),
    /didn't match/,
  );
});

test("dev sign-in: /v1/dev/login then identity", async () => {
  const calls = [];
  const out = await devSignIn(" owner@demo.test ", "Olive", {
    devLogin: async (email, name) => {
      calls.push(["login", email, name]);
      return { access_token: "a", id_token: "i", token_type: "Bearer", expires_in: 43200, sub: "s" };
    },
    syncIdentity: async (a, i) => {
      calls.push(["identity", a, i]);
      return { user: { email: "owner@demo.test" }, stores: [{ tenant_id: "t" }] };
    },
    now: 0,
  });
  assert.deepEqual(calls, [["login", "owner@demo.test", "Olive"], ["identity", "a", "i"]]);
  assert.equal(out.session.mode, "dev");
  assert.equal(out.session.expiresAt, 43_200_000);
  await assert.rejects(devSignIn("nope", "", {}), /email/);
});

test("ensureFresh refreshes Cognito tokens and signs out dev ones", async () => {
  const fresh = { mode: "cognito", accessToken: "a", refreshToken: "r", expiresAt: 10_000_000 };
  assert.equal(await ensureFresh(fresh, CONFIG, { now: 0 }), fresh);
  const due = { ...fresh, expiresAt: 30_000 };
  const renewed = await ensureFresh(due, CONFIG, {
    now: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: "a2", expires_in: 3600 }) }),
  });
  assert.equal(renewed.accessToken, "a2");
  assert.equal(renewed.refreshToken, "r");
  const revoked = await ensureFresh(due, CONFIG, {
    now: 0,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }),
  });
  assert.equal(revoked, null);
  assert.equal(await ensureFresh({ mode: "dev", accessToken: "a", expiresAt: 30_000 }, CONFIG, { now: 0 }), null);
});

test("endBackOfficeSession clears storage, revokes the refresh token and logs out", async () => {
  const storage = memoryStorage();
  const session = { mode: "cognito", accessToken: "a", refreshToken: "r-123", expiresAt: 1 };
  writeJson(storage, SESSION_KEY, session);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const url = await endBackOfficeSession(CONFIG, session, { storage, origin: ORIGIN, fetchImpl });
  assert.equal(readJson(storage, SESSION_KEY), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.example.com/oauth2/revoke");
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("token"), "r-123");
  assert.equal(body.get("client_id"), "cid");
  assert.match(url, /\/logout\?client_id=cid&logout_uri=/);

  // Revocation is best effort: a failure still signs the browser out.
  writeJson(storage, SESSION_KEY, session);
  const failing = async () => {
    throw new Error("offline");
  };
  assert.ok(await endBackOfficeSession(CONFIG, session, { storage, origin: ORIGIN, fetchImpl: failing }));
  assert.equal(readJson(storage, SESSION_KEY), null);

  // Dev login: nothing to revoke, no logout page.
  writeJson(storage, SESSION_KEY, { mode: "dev", accessToken: "d" });
  const none = async () => assert.fail("no fetch for dev sessions");
  assert.equal(
    await endBackOfficeSession({ mode: "dev" }, { mode: "dev", accessToken: "d" }, { storage, origin: ORIGIN, fetchImpl: none }),
    null,
  );
  assert.equal(readJson(storage, SESSION_KEY), null);
  assert.equal(await endBackOfficeSession(CONFIG, null, { storage, origin: ORIGIN, fetchImpl: none }), null);
});

test("an enrolled register forces the hosted UI to ask for credentials", async () => {
  const sessionStore = memoryStorage();
  const plain = new URL(await beginCognitoSignIn(CONFIG, { origin: ORIGIN, sessionStore }));
  assert.equal(plain.searchParams.get("prompt"), null);
  const forced = new URL(await beginCognitoSignIn(CONFIG, { origin: ORIGIN, sessionStore, forceLogin: true }));
  assert.equal(forced.searchParams.get("prompt"), "login");
});

test("signOutUrl only for Cognito sessions", () => {
  assert.match(signOutUrl(CONFIG, { mode: "cognito" }, ORIGIN), /\/logout\?client_id=cid&logout_uri=/);
  assert.equal(signOutUrl({ mode: "dev" }, { mode: "dev" }, ORIGIN), null);
});

test("inviteTokenFrom reads /invite?token=", () => {
  const token = "x".repeat(43);
  assert.equal(inviteTokenFrom("/invite", `?token=${token}`), token);
  assert.equal(inviteTokenFrom("/invite/", `?token=${token}`), token);
  assert.equal(inviteTokenFrom("/", `?token=${token}`), null);
  assert.equal(inviteTokenFrom("/invite", "?token=short"), null);
});
