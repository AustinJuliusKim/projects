import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizeUrl,
  challengeFor,
  checkCallback,
  codeExchangeParams,
  cognitoBase,
  createPkce,
  logoutUrl,
  randomString,
  refreshParams,
  tokenRequest,
} from "../src/pkce.js";

test("challengeFor is the RFC 7636 S256 transform", async () => {
  // Appendix B test vector.
  assert.equal(
    await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("createPkce makes a url-safe verifier, its challenge and a state", async () => {
  const p = await createPkce();
  assert.equal(p.verifier.length, 64);
  assert.match(p.verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(p.challenge, await challengeFor(p.verifier));
  assert.equal(p.state.length, 24);
  assert.notEqual(randomString(32), randomString(32));
});

test("cognitoBase accepts the stack output or a bare host", () => {
  assert.equal(cognitoBase("https://x.auth.us-east-1.amazoncognito.com/"), "https://x.auth.us-east-1.amazoncognito.com");
  assert.equal(cognitoBase("x.auth.us-east-1.amazoncognito.com"), "https://x.auth.us-east-1.amazoncognito.com");
  assert.equal(cognitoBase(""), "");
});

test("authorizeUrl and logoutUrl", () => {
  const url = new URL(
    authorizeUrl({
      domain: "auth.example.com",
      clientId: "cid",
      redirectUri: "http://localhost:5173/auth/callback",
      challenge: "chal",
      state: "st",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://auth.example.com/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:5173/auth/callback");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  assert.equal(url.searchParams.get("state"), "st");
  const out = new URL(logoutUrl({ domain: "auth.example.com", clientId: "cid", logoutUri: "http://x/" }));
  assert.equal(out.pathname, "/logout");
  assert.equal(out.searchParams.get("logout_uri"), "http://x/");
});

test("checkCallback requires a code and the stored state", () => {
  const stored = { verifier: "v", state: "s1" };
  assert.deepEqual(checkCallback("?code=abc&state=s1", stored), { code: "abc" });
  assert.match(checkCallback("?code=abc&state=other", stored).error, /didn't match/);
  assert.match(checkCallback("?code=abc&state=s1", null).error, /didn't match/);
  assert.match(checkCallback("?state=s1", stored).error, /no code/);
  assert.equal(
    checkCallback("?error=access_denied&error_description=nope", stored).error,
    "nope",
  );
});

test("token grants and the token request", async () => {
  assert.deepEqual(codeExchangeParams({ clientId: "c", code: "k", redirectUri: "r", verifier: "v" }), {
    grant_type: "authorization_code",
    client_id: "c",
    code: "k",
    redirect_uri: "r",
    code_verifier: "v",
  });
  assert.equal(refreshParams({ clientId: "c", refreshToken: "rt" }).grant_type, "refresh_token");
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ access_token: "a" }) };
  };
  assert.deepEqual(await tokenRequest("auth.example.com", { a: "1 2" }, fetchImpl), { access_token: "a" });
  assert.equal(seen.url, "https://auth.example.com/oauth2/token");
  assert.equal(seen.init.body, "a=1+2");
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
  await assert.rejects(tokenRequest("d", {}, failing), /invalid_grant/);
});
