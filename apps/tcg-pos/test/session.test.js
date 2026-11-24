import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authConfig,
  EXPIRY_SKEW_MS,
  jwtClaims,
  readJson,
  sessionFromTokens,
  sessionStatus,
  writeJson,
} from "../src/session.js";

const COGNITO = { VITE_COGNITO_DOMAIN: "auth.example.com", VITE_COGNITO_CLIENT_ID: "cid" };

test("authConfig: dev builds fall back to dev login", () => {
  assert.equal(authConfig({}).mode, "dev");
  assert.equal(authConfig({ VITE_AUTH_MODE: "dev", ...COGNITO }).mode, "dev");
  const c = authConfig(COGNITO);
  assert.equal(c.mode, "cognito");
  assert.equal(c.redirectPath, "/auth/callback");
});

test("authConfig: production never offers dev login", () => {
  assert.equal(authConfig({ PROD: true, ...COGNITO }).mode, "cognito");
  const missing = authConfig({ PROD: true });
  assert.equal(missing.mode, "error");
  assert.match(missing.error, /VITE_COGNITO_DOMAIN/);
  const dev = authConfig({ PROD: true, VITE_AUTH_MODE: "dev", ...COGNITO });
  assert.equal(dev.mode, "error");
  assert.match(dev.error, /local development only/);
});

test("sessionFromTokens and sessionStatus", () => {
  const now = 1_000_000;
  const s = sessionFromTokens(
    { access_token: "a", id_token: "i", refresh_token: "r", expires_in: 3600 },
    { mode: "cognito", now },
  );
  assert.equal(s.expiresAt, now + 3_600_000);
  assert.equal(sessionStatus(s, now), "fresh");
  assert.equal(sessionStatus(s, s.expiresAt - EXPIRY_SKEW_MS + 1), "refresh");
  // A refresh response has no refresh token: keep the old one.
  const r = sessionFromTokens({ access_token: "b", expires_in: 60 }, { mode: "cognito", now, previous: s });
  assert.equal(r.refreshToken, "r");
  assert.equal(r.idToken, "i");
  // Dev tokens can't refresh: expired means signed out.
  const d = sessionFromTokens({ access_token: "a", expires_in: 10 }, { mode: "dev", now });
  assert.equal(sessionStatus(d, now + 10_000), "expired");
  assert.equal(sessionStatus(null), "expired");
  assert.throws(() => sessionFromTokens({}, { mode: "dev" }), /access_token/);
});

test("readJson/writeJson tolerate bad JSON and missing storage", () => {
  const m = new Map();
  const storage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
  writeJson(storage, "k", { a: 1 });
  assert.deepEqual(readJson(storage, "k"), { a: 1 });
  writeJson(storage, "k", null);
  assert.equal(readJson(storage, "k"), null);
  m.set("bad", "{nope");
  assert.equal(readJson(storage, "bad"), null);
  assert.equal(readJson(undefined, "k"), null);
  writeJson(undefined, "k", 1); // no throw
});

test("jwtClaims decodes the payload (display only)", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "u1", email: "a@b.c" })).toString("base64url");
  assert.deepEqual(jwtClaims(`h.${payload}.s`), { sub: "u1", email: "a@b.c" });
  assert.equal(jwtClaims("garbage"), null);
});
