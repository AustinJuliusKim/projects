import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../src/app.js";
import { createMemRepo } from "./memRepo.js";
import { createFakeAdapter } from "../src/auth/fakeAdapter.js";
import { loadConfig } from "../src/config.js";

const ANON_ID = "11111111-2222-4333-8444-555555555555";

function makeApp() {
  const repo = createMemRepo();
  const authAdapter = createFakeAdapter();
  const config = loadConfig({ PUBLIC_ORIGIN: "https://learn.example.com", SESSION_TTL_DAYS: "30" });
  const app = buildApp({ repo, authAdapter, config });
  return { app, repo, authAdapter };
}

/** Signs in via the fake adapter, returning the session cookie value. */
async function signIn(app, email, anonId) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    payload: { tokenHash: `fake-${email}`, type: "magiclink", ...(anonId ? { anonId } : {}) },
  });
  assert.equal(res.statusCode, 200);
  const cookie = res.cookies.find((c) => c.name === "gr_session");
  assert.ok(cookie, "verify sets the session cookie");
  return { cookie, body: res.json() };
}

test("health responds ok", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("magic-link issues a link and upserts a lead for the anon id", async () => {
  const { app, repo, authAdapter } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/magic-link",
    payload: { email: "Ada@Example.com", anonId: ANON_ID },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(authAdapter.issued.length, 1);
  assert.equal(authAdapter.issued[0].email, "ada@example.com");
  assert.equal(authAdapter.issued[0].redirectTo, "https://learn.example.com/auth/callback");
  assert.equal(repo.state.leads.length, 1);
  assert.equal(repo.state.leads[0].email, "ada@example.com");
  assert.equal(repo.state.leads[0].source, "magic-link-request");
});

test("magic-link rejects an invalid email", async () => {
  const { app, authAdapter } = makeApp();
  const res = await app.inject({ method: "POST", url: "/api/auth/magic-link", payload: { email: "nope" } });
  assert.equal(res.statusCode, 400);
  assert.equal(authAdapter.issued.length, 0);
});

test("verify: creates the user, session cookie flags, account_created event, anon merge", async () => {
  const { app, repo } = makeApp();

  // Anonymous progress + an event exist before sign-in.
  await repo.upsertProgress({ ownerType: "anon", ownerId: ANON_ID, lessonId: "l1", status: "completed" });
  await repo.insertEvents([{ ownerType: "anon", ownerId: ANON_ID, kind: "lesson_completed", payload: {} }]);

  const { cookie, body } = await signIn(app, "ada@example.com", ANON_ID);
  assert.equal(body.user.email, "ada@example.com");

  // Cookie flags (Accounts spec: httpOnly first-party session).
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "Lax");
  assert.equal(cookie.path, "/");

  // Anon merge happened in the same transaction.
  const user = repo.state.users[0];
  const progress = await repo.listProgress({ ownerType: "user", ownerId: user.id });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].lesson_id, "l1");
  assert.equal(repo.state.progress.filter((p) => p.owner_type === "anon").length, 0);
  assert.ok(repo.state.events.every((e) => e.owner_type === "user" && e.owner_id === user.id));
  assert.ok(repo.state.events.some((e) => e.kind === "account_created"));
});

test("verify with a bad token is 401 and sets no cookie", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    payload: { tokenHash: "bogus", type: "magiclink" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.cookies.length, 0);
});

test("verify twice reuses the same user (no duplicate account_created)", async () => {
  const { app, repo } = makeApp();
  await signIn(app, "ada@example.com");
  await signIn(app, "ada@example.com");
  assert.equal(repo.state.users.length, 1);
  assert.equal(repo.state.events.filter((e) => e.kind === "account_created").length, 1);
  assert.equal(repo.state.sessions.length, 2);
});

test("me returns the profile with a session, 401 without", async () => {
  const { app } = makeApp();
  const { cookie } = await signIn(app, "ada@example.com");

  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { gr_session: cookie.value } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, "ada@example.com");

  const anon = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(anon.statusCode, 401);
});

test("logout deletes the session", async () => {
  const { app, repo } = makeApp();
  const { cookie } = await signIn(app, "ada@example.com");

  const res = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { gr_session: cookie.value } });
  assert.equal(res.statusCode, 200);
  assert.equal(repo.state.sessions.length, 0);

  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { gr_session: cookie.value } });
  assert.equal(me.statusCode, 401);
});

test("leads: valid capture is stored; the server re-runs sanitizeUserName", async () => {
  const { app, repo } = makeApp();
  const ok = await app.inject({
    method: "POST",
    url: "/api/leads",
    payload: { anonId: ANON_ID, name: "  Ada   Lovelace ", consent: false, source: "l1-capture-name" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(repo.state.leads[0].name, "Ada Lovelace");

  const bad = await app.inject({
    method: "POST",
    url: "/api/leads",
    payload: { anonId: ANON_ID, name: "<img onerror=x>", consent: false, source: "l1-capture-name" },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(repo.state.leads.length, 1);
});

test("leads: requires name or email, valid anonId and source", async () => {
  const { app } = makeApp();
  const empty = await app.inject({
    method: "POST",
    url: "/api/leads",
    payload: { anonId: ANON_ID, consent: true, source: "l1-capture-email" },
  });
  assert.equal(empty.statusCode, 400);

  const badAnon = await app.inject({
    method: "POST",
    url: "/api/leads",
    payload: { anonId: "not-a-uuid", email: "a@b.co", consent: false, source: "x" },
  });
  assert.equal(badAnon.statusCode, 400);
});

test("progress: anon put/get round-trips; invalid status rejected", async () => {
  const { app } = makeApp();
  const put = await app.inject({
    method: "PUT",
    url: "/api/progress/l1",
    payload: { status: "completed", assertions: { grade: true }, anonId: ANON_ID },
  });
  assert.equal(put.statusCode, 200);

  const get = await app.inject({ method: "GET", url: `/api/progress?anonId=${ANON_ID}` });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json().progress[0].lesson_id, "l1");

  const bad = await app.inject({
    method: "PUT",
    url: "/api/progress/l1",
    payload: { status: "perfect", anonId: ANON_ID },
  });
  assert.equal(bad.statusCode, 400);

  const noOwner = await app.inject({ method: "GET", url: "/api/progress" });
  assert.equal(noOwner.statusCode, 400);
});

test("progress: session owner wins over anonId", async () => {
  const { app, repo } = makeApp();
  const { cookie } = await signIn(app, "ada@example.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/progress/l2",
    payload: { status: "started", anonId: ANON_ID },
    cookies: { gr_session: cookie.value },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(repo.state.progress[0].owner_type, "user");
});

test("events: kind allowlist enforced", async () => {
  const { app, repo } = makeApp();
  const ok = await app.inject({
    method: "POST",
    url: "/api/events",
    payload: { anonId: ANON_ID, events: [{ kind: "lesson_started", payload: { lessonId: "l1" } }] },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(repo.state.events.length, 1);

  const bad = await app.inject({
    method: "POST",
    url: "/api/events",
    payload: { anonId: ANON_ID, events: [{ kind: "totally_made_up" }] },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(repo.state.events.length, 1);
});

test("account: profile+progress+balance behind the session; PATCH sanitizes name", async () => {
  const { app, repo } = makeApp();
  const anon = await app.inject({ method: "GET", url: "/api/account" });
  assert.equal(anon.statusCode, 401);

  const { cookie } = await signIn(app, "ada@example.com");
  const user = repo.state.users[0];
  repo.state.wallet.push({ user_id: user.id, type: "topup", amount_cents: 500 });

  const res = await app.inject({ method: "GET", url: "/api/account", cookies: { gr_session: cookie.value } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().balanceCents, 500);

  const patch = await app.inject({
    method: "PATCH",
    url: "/api/account",
    payload: { name: " Ada  Lovelace ", marketingConsent: true },
    cookies: { gr_session: cookie.value },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().user.name, "Ada Lovelace");
  assert.equal(patch.json().user.marketingConsent, true);

  const badPatch = await app.inject({
    method: "PATCH",
    url: "/api/account",
    payload: { name: "<script>" },
    cookies: { gr_session: cookie.value },
  });
  assert.equal(badPatch.statusCode, 400);
});

test("account export returns the full dump", async () => {
  const { app } = makeApp();
  const { cookie } = await signIn(app, "ada@example.com", ANON_ID);
  const res = await app.inject({
    method: "GET",
    url: "/api/account/export",
    cookies: { gr_session: cookie.value },
  });
  assert.equal(res.statusCode, 200);
  const dump = res.json();
  assert.equal(dump.user.email, "ada@example.com");
  assert.ok(Array.isArray(dump.progress));
  assert.ok(Array.isArray(dump.events));
  assert.ok(Array.isArray(dump.walletLedger));
});

test("account delete purges PII and anonymizes events", async () => {
  const { app, repo } = makeApp();
  await repo.upsertLead({ anonId: ANON_ID, email: "ada@example.com", consent: true, source: "l1" });
  const { cookie } = await signIn(app, "ada@example.com", ANON_ID);
  const user = repo.state.users[0];
  repo.state.wallet.push({ user_id: user.id, type: "topup", amount_cents: 500 });

  const res = await app.inject({ method: "DELETE", url: "/api/account", cookies: { gr_session: cookie.value } });
  assert.equal(res.statusCode, 200);

  assert.equal(repo.state.users.length, 0);
  assert.equal(repo.state.sessions.length, 0);
  assert.equal(repo.state.wallet.length, 0);
  // Events retained, anonymized; lead PII nulled.
  assert.ok(repo.state.events.length > 0);
  assert.ok(repo.state.events.every((e) => e.owner_id === null));
  assert.ok(repo.state.leads.every((l) => l.email === null && l.name === null));

  const me = await app.inject({ method: "GET", url: "/api/me", cookies: { gr_session: cookie.value } });
  assert.equal(me.statusCode, 401);
});
