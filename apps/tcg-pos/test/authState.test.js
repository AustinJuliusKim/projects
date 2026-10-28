import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentAuth,
  currentStore,
  initialState,
  persistableSession,
  pickStore,
  reducer,
  registerSessionFrom,
  screen,
} from "../src/authState.js";

const DEV = { mode: "dev" };
const SESSION = { mode: "dev", accessToken: "tok", expiresAt: Date.now() + 3600_000 };
const STORES = [
  { tenant_id: "s1", name: "One", role: "owner", role_name: "Owner" },
  { tenant_id: "s2", name: "Two", role: "cashier", role_name: "Cashier" },
];
const DEVICE = { secret: "tcgdev_x", deviceId: "d1", registerName: "Front" };

function run(state, ...actions) {
  return actions.reduce(reducer, state);
}

test("pickStore remembers the last store while it's still yours", () => {
  assert.equal(pickStore(STORES, "s2"), "s2");
  assert.equal(pickStore(STORES, "gone"), "s1");
  assert.equal(pickStore([], "s2"), null);
});

test("back office: signed out → loading → store → signed out", () => {
  let s = initialState({ config: DEV, tenantId: "s2" });
  assert.equal(screen(s), "signed_out");
  assert.equal(currentAuth(s), null);
  s = reducer(s, { type: "signed_in", session: SESSION });
  assert.equal(screen(s), "loading");
  s = reducer(s, { type: "me_loaded", me: { user: { id: "u" }, stores: STORES } });
  assert.equal(screen(s), "backoffice");
  assert.equal(s.tenantId, "s2");
  assert.equal(currentStore(s).name, "Two");
  assert.deepEqual(currentAuth(s), { kind: "bearer", token: "tok", tenantId: "s2" });
  s = reducer(s, { type: "store_selected", tenantId: "s1" });
  assert.equal(currentAuth(s).tenantId, "s1");
  s = reducer(s, { type: "auth_failure", kind: "sign_in" });
  assert.equal(screen(s), "signed_out");
  assert.match(s.notice, /signed out/);
});

test("a user with no store gets the create-store screen", () => {
  let s = run(
    initialState({ config: DEV }),
    { type: "signed_in", session: SESSION },
    { type: "me_loaded", me: { user: {}, stores: [] } },
  );
  assert.equal(screen(s), "no_store");
  s = reducer(s, { type: "store_created", store: STORES[0] });
  assert.equal(screen(s), "backoffice");
  assert.equal(s.tenantId, "s1");
});

test("production without Cognito config is a config error", () => {
  assert.equal(screen(initialState({ config: { mode: "error", error: "x" } })), "config_error");
});

test("register mode: lock screen, PIN session, lock, idle and revoked device", () => {
  let s = initialState({ config: DEV, session: SESSION });
  s = reducer(s, { type: "surface", surface: "register" }); // no device: ignored
  assert.equal(s.surface, "backoffice");
  s = reducer(s, { type: "device_enrolled", device: DEVICE });
  assert.equal(screen(s), "register_locked");
  assert.deepEqual(currentAuth(s), { kind: "device", secret: "tcgdev_x", sessionToken: null });

  const rs = registerSessionFrom({
    session_id: "rs1",
    session_token: "tcgreg_y",
    user_id: "u2",
    name: "Cass",
    role: "cashier",
    perms: ["pos.sell"],
    expires_at: "2026-10-14T12:00:00Z",
    idle_timeout_seconds: 1800,
  });
  assert.equal(rs.idleTimeoutSeconds, 1800);
  assert.equal(rs.expiresAt, Date.parse("2026-10-14T12:00:00Z"));
  s = reducer(s, { type: "register_signed_in", registerSession: rs });
  assert.equal(screen(s), "register");
  assert.equal(currentAuth(s).sessionToken, "tcgreg_y");

  // A stale bearer token doesn't touch the register.
  assert.equal(reducer(s, { type: "auth_failure", kind: "sign_in" }), s);

  s = reducer(s, { type: "auth_failure", kind: "pin", message: "timed out" });
  assert.equal(screen(s), "register_locked");
  assert.equal(s.notice, "timed out");

  s = reducer(s, { type: "register_signed_in", registerSession: rs });
  s = reducer(s, { type: "surface", surface: "backoffice" }); // leaving locks it
  assert.equal(s.registerSession, null);
  assert.equal(screen(s), "signed_out");

  s = run(s, { type: "surface", surface: "register" }, { type: "auth_failure", kind: "enroll" });
  assert.equal(s.device, null);
  assert.equal(s.surface, "backoffice");
  assert.match(s.notice, /enroll it again/);
});

// Security review P1: enrolling used to leave the manager's session (and
// Cognito refresh token) in place, so "Back office" on the lock screen
// opened the back office as them.
test("enrolling a browser ends the back-office session that enrolled it", () => {
  const cognito = { mode: "cognito", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
  let s = run(
    initialState({ config: DEV }),
    { type: "signed_in", session: cognito },
    { type: "me_loaded", me: { user: { id: "mgr" }, stores: STORES } },
  );
  assert.equal(screen(s), "backoffice");
  s = reducer(s, { type: "device_enrolled", device: DEVICE, notice: "signed out" });
  assert.equal(s.session, null);
  assert.equal(s.me, null);
  assert.equal(screen(s), "register_locked");
  assert.equal(s.notice, "signed out");
  assert.equal(currentAuth(s).kind, "device");
  assert.equal(persistableSession(s.session, s.device), null);

  // The lock screen's "Back office" is a sign-in screen, never the
  // enroller's back office.
  s = reducer(s, { type: "surface", surface: "backoffice" });
  assert.equal(screen(s), "signed_out");
  assert.equal(currentAuth(s), null);
});

test("on an enrolled browser the back office always needs a fresh sign-in", () => {
  const cognito = { mode: "cognito", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
  // A session stored by an older build is not resumed.
  let s = initialState({ config: DEV, session: cognito, device: DEVICE, surface: "backoffice" });
  assert.equal(s.session, null);
  assert.equal(screen(s), "signed_out");
  // A fresh sign-in works, but keeps no refresh token and isn't persisted.
  s = run(s, { type: "signed_in", session: cognito }, { type: "me_loaded", me: { user: {}, stores: STORES } });
  assert.equal(screen(s), "backoffice");
  assert.equal(s.session.accessToken, "a");
  assert.equal(s.session.refreshToken, null);
  assert.equal(reducer(s, { type: "session_refreshed", session: cognito }).session.refreshToken, null);
  assert.equal(persistableSession(s.session, s.device), null);
  // Opening the register signs them out; coming back means signing in again.
  s = reducer(s, { type: "surface", surface: "register" });
  assert.equal(s.session, null);
  assert.equal(screen(s), "register_locked");
  s = reducer(s, { type: "surface", surface: "backoffice" });
  assert.equal(screen(s), "signed_out");
  // A browser that isn't a register persists its session as before.
  assert.equal(persistableSession(cognito, null), cognito);
});

test("initialState only restores register mode with a device", () => {
  assert.equal(initialState({ config: DEV, surface: "register" }).surface, "backoffice");
  const s = initialState({ config: DEV, surface: "register", device: DEVICE, registerSession: { token: "t" } });
  assert.equal(screen(s), "register");
  assert.equal(initialState({ config: DEV, registerSession: { token: "t" } }).registerSession, null);
});
