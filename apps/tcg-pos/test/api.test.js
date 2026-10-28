import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiError,
  buildHeaders,
  buildQuery,
  classifyError,
  configureApi,
  errorMessage,
  request,
} from "../src/api.js";

test("buildQuery drops empty values and encodes", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ location_id: null, printing_id: "" }), "");
  assert.equal(buildQuery({ page: 2, page_size: 50 }), "?page=2&page_size=50");
});

test("errorMessage reads FastAPI string and validation details", () => {
  assert.equal(errorMessage(409, { detail: "would go negative" }), "would go negative");
  assert.equal(
    errorMessage(422, { detail: [{ loc: ["body", "price_cents"], msg: "too big" }] }),
    "price_cents: too big",
  );
  assert.equal(errorMessage(502, {}), "API error 502");
});

test("errorMessage reads the auth routes' object details", () => {
  assert.equal(
    errorMessage(403, { detail: { missing: "staff.manage" } }),
    "You don't have permission to do that (staff.manage).",
  );
  assert.match(
    errorMessage(403, { detail: { missing: "apikeys.manage", reason: "back_office_only" } }),
    /back-office task \(apikeys\.manage\)/,
  );
  assert.equal(
    errorMessage(403, { detail: { reason: "wrong_pin", attempts_left: 1 } }),
    "Wrong PIN. 1 attempt left before it locks.",
  );
  assert.equal(
    errorMessage(423, { detail: { reason: "pin_locked", retry_after: 60 } }),
    "Too many wrong PINs: locked for 60 seconds.",
  );
  assert.equal(
    errorMessage(423, { detail: { reason: "pin_locked", retry_after: 60, scope: "device" } }),
    "Too many wrong PINs: locked on this register for 60 seconds.",
  );
  assert.equal(
    errorMessage(423, { detail: { reason: "pin_locked", retry_after: 3600, scope: "store" } }),
    "Too many wrong PINs: locked on every register for 3600 seconds.",
  );
  assert.equal(
    errorMessage(423, { detail: { reason: "pin_locked", retry_after: 60 } }),
    "Too many wrong PINs: locked for 60 seconds.",
  );
  assert.match(errorMessage(403, { detail: { reason: "self_approval" } }), /can't approve your own/);
  assert.match(
    errorMessage(403, { detail: { reason: "approver_not_allowed", perm: "credit.adjust" } }),
    /needs credit.adjust and approve.override/,
  );
  assert.match(
    errorMessage(403, { detail: { approval_required: "credit.adjust", payload_hash: "x", approval_error: "invalid" } }),
    /invalid, expired or already used/,
  );
  // Escalation 403 (routes/staff.check_grantable).
  assert.equal(
    errorMessage(403, {
      detail: { reason: "you can't grant a role with permissions you don't have", missing: ["billing.manage"] },
    }),
    "you can't grant a role with permissions you don't have: billing.manage",
  );
  assert.equal(
    errorMessage(403, { detail: { reason: "only an owner can grant the owner role" } }),
    "only an owner can grant the owner role",
  );
  // API-key 422 with forbidden perms.
  assert.equal(
    errorMessage(422, { detail: { reason: "API keys can't hold these permissions", perms: ["staff.manage"] } }),
    "API keys can't hold these permissions: staff.manage",
  );
  assert.match(errorMessage(403, { detail: { reason: "store_limit", limit: 5 } }), /maximum of 5 stores/);
  assert.match(
    errorMessage(401, { detail: { reason: "session_idle", message: "the register session timed out" } }),
    /locked after being idle/,
  );
  assert.equal(
    errorMessage(429, { detail: "too many requests; try again shortly" }, { retryAfter: 12 }),
    "Too many attempts; try again in 12 seconds.",
  );
});

test("buildHeaders: bearer + tenant, device + session, approval; never X-Actor", () => {
  assert.deepEqual(buildHeaders(null), {});
  assert.deepEqual(buildHeaders({ kind: "bearer", token: "t", tenantId: "s1" }), {
    Authorization: "Bearer t",
    "X-Tenant-Id": "s1",
  });
  assert.deepEqual(buildHeaders({ kind: "bearer", token: "t", tenantId: "s1" }, { tenant: false }), {
    Authorization: "Bearer t",
  });
  assert.deepEqual(buildHeaders({ kind: "device", secret: "tcgdev_x", sessionToken: "tcgreg_y" }), {
    Authorization: "Device tcgdev_x",
    "X-Register-Session": "tcgreg_y",
  });
  assert.deepEqual(buildHeaders({ kind: "device", secret: "tcgdev_x" }, { approvalId: "ap1" }), {
    Authorization: "Device tcgdev_x",
    "X-Approval": "ap1",
  });
});

test("classifyError maps 401 reasons to app state", () => {
  assert.equal(classifyError(401, "invalid token", { scheme: "bearer" }), "sign_in");
  assert.equal(classifyError(401, "authentication required"), "sign_in");
  assert.equal(classifyError(401, { reason: "device_unknown" }, { scheme: "device" }), "enroll");
  for (const r of ["session_required", "session_invalid", "session_ended", "session_expired", "session_idle"]) {
    assert.equal(classifyError(401, { reason: r }, { scheme: "device" }), "pin");
  }
  // Device credential on a bearer-only route: don't drop the enrollment.
  assert.equal(classifyError(401, "expected an Authorization: Bearer credential", { scheme: "device" }), "error");
  assert.equal(classifyError(403, { approval_required: "credit.adjust" }), "approval");
  assert.equal(classifyError(403, { missing: "x" }), "forbidden");
  assert.equal(classifyError(423, { reason: "pin_locked" }), "pin_locked");
  assert.equal(classifyError(429, "slow down"), "rate_limited");
  assert.equal(classifyError(500, "boom"), "error");
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const r = responses.shift();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map(Object.entries(r.headers || {})),
      json: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test("request attaches the provider's credential and reports auth failures", async () => {
  const failures = [];
  configureApi({
    getAuth: async () => ({ kind: "device", secret: "tcgdev_x", sessionToken: "tcgreg_y" }),
    onAuthFailure: (f) => failures.push(f),
  });
  const ok = fakeFetch([{ status: 200, body: { total: 0 } }]);
  assert.deepEqual(await request("GET", "/v1/inventory", { params: { page: 1 }, base: "", fetchImpl: ok }), { total: 0 });
  assert.equal(ok.calls[0].url, "/v1/inventory?page=1");
  assert.equal(ok.calls[0].headers.Authorization, "Device tcgdev_x");
  assert.equal(ok.calls[0].headers["X-Register-Session"], "tcgreg_y");
  assert.equal(ok.calls[0].headers["X-Actor"], undefined);

  const idle = fakeFetch([{ status: 401, body: { detail: { reason: "session_idle", message: "m" } } }]);
  await assert.rejects(request("GET", "/v1/inventory", { base: "", fetchImpl: idle }), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.kind, "pin");
    assert.equal(e.reason, "session_idle");
    return true;
  });
  assert.deepEqual(failures.map((f) => f.kind), ["pin"]);

  // Explicit auth (mid-sign-in): not reported.
  const bad = fakeFetch([{ status: 401, body: { detail: "bad token" } }]);
  await assert.rejects(request("GET", "/v1/me", { base: "", auth: { kind: "bearer", token: "t" }, fetchImpl: bad }));
  assert.equal(failures.length, 1);

  const locked = fakeFetch([
    { status: 423, body: { detail: { reason: "pin_locked", retry_after: 30 } }, headers: { "Retry-After": "30" } },
  ]);
  await assert.rejects(request("POST", "/v1/register/sessions", { base: "", json: {}, fetchImpl: locked }), (e) => {
    assert.equal(e.kind, "pin_locked");
    assert.equal(e.retryAfter, 30);
    return true;
  });

  const empty = fakeFetch([{ status: 204 }]);
  assert.equal(await request("DELETE", "/v1/register/sessions", { base: "", fetchImpl: empty }), null);
  configureApi({ getAuth: async () => null, onAuthFailure: () => {} });
});

test("request sends JSON bodies and X-Approval", async () => {
  configureApi({ getAuth: () => ({ kind: "bearer", token: "t", tenantId: "s1" }) });
  const f = fakeFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);
  await request("POST", "/v1/x", { base: "", json: { a: 1 }, approvalId: "ap", fetchImpl: f });
  assert.equal(f.calls[0].body, '{"a":1}');
  assert.equal(f.calls[0].headers["Content-Type"], "application/json");
  assert.equal(f.calls[0].headers["X-Approval"], "ap");
  assert.equal(f.calls[0].headers["X-Tenant-Id"], "s1");
  await request("GET", "/v1/me", { base: "", tenant: false, fetchImpl: f });
  assert.equal(f.calls[1].headers["X-Tenant-Id"], undefined);
  configureApi({ getAuth: async () => null });
});
