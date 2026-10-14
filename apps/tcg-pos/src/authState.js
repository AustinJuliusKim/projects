// The app's auth state as one pure reducer (App wires it to useReducer and
// persists the slices it says to). Two surfaces share a browser:
//
//   backoffice  a person signed in with their own account (Cognito, or dev
//               login locally): bearer token + the store they picked.
//   register    this browser is an enrolled register (device secret in
//               localStorage); staff sign in on it with a PIN, and the
//               session token lives in sessionStorage.
//
// screen(state) says what to render; currentAuth(state) is the credential
// the API client sends.

export function initialState({
  config,
  session = null,
  tenantId = null,
  device = null,
  registerSession = null,
  surface = "backoffice",
} = {}) {
  return {
    config,
    session,
    me: null,
    tenantId,
    device,
    registerSession: device ? registerSession : null,
    surface: device && surface === "register" ? "register" : "backoffice",
    notice: null,
  };
}

// The remembered store if the user still belongs to it, else their first.
export function pickStore(stores, remembered) {
  if (!Array.isArray(stores) || stores.length === 0) return null;
  if (remembered && stores.some((s) => s.tenant_id === remembered)) return remembered;
  return stores[0].tenant_id;
}

// A register session as the app keeps it, from POST /v1/register/sessions.
export function registerSessionFrom(r, now = Date.now()) {
  return {
    token: r.session_token,
    sessionId: r.session_id,
    userId: r.user_id,
    name: r.name,
    role: r.role,
    perms: r.perms || [],
    expiresAt: Date.parse(r.expires_at) || null,
    idleTimeoutSeconds: r.idle_timeout_seconds || 1800,
    signedInAt: now,
  };
}

const AUTH_FAILURE_NOTICE = {
  sign_in: "You were signed out. Sign in again.",
  enroll: "This register's enrollment is no longer valid. A manager needs to enroll it again.",
};

export function reducer(state, action) {
  switch (action.type) {
    case "signed_in":
      return { ...state, session: action.session, me: null, notice: null };
    case "session_refreshed":
      return { ...state, session: action.session };
    case "signed_out":
      return { ...state, session: null, me: null, notice: action.notice || null };
    case "me_loaded":
      return { ...state, me: action.me, tenantId: pickStore(action.me.stores, state.tenantId) };
    case "store_selected":
      return { ...state, tenantId: action.tenantId };
    case "store_created": {
      const stores = [...((state.me && state.me.stores) || []), action.store];
      return { ...state, me: { ...state.me, stores }, tenantId: action.store.tenant_id };
    }
    case "device_enrolled":
      return { ...state, device: action.device, registerSession: null };
    case "device_forgotten":
      return {
        ...state,
        device: null,
        registerSession: null,
        surface: "backoffice",
        notice: action.notice || null,
      };
    case "surface":
      if (action.surface === "register" && !state.device) return state;
      return {
        ...state,
        surface: action.surface,
        // Leaving the register locks it: the next person starts at the PIN pad.
        registerSession: action.surface === "register" ? state.registerSession : null,
        notice: null,
      };
    case "register_signed_in":
      return { ...state, registerSession: action.registerSession, notice: null };
    case "register_locked":
      return { ...state, registerSession: null, notice: action.notice || null };
    case "auth_failure":
      if (action.kind === "sign_in") {
        // A stale bearer token only matters to the back office.
        if (state.surface === "register") return state;
        return reducer(state, { type: "signed_out", notice: AUTH_FAILURE_NOTICE.sign_in });
      }
      if (action.kind === "enroll") {
        return reducer(state, { type: "device_forgotten", notice: AUTH_FAILURE_NOTICE.enroll });
      }
      if (action.kind === "pin") {
        return reducer(state, { type: "register_locked", notice: action.message || null });
      }
      return state;
    case "notice":
      return { ...state, notice: action.notice || null };
    default:
      return state;
  }
}

// config_error | signed_out | loading | no_store | backoffice
// | register_locked | register
export function screen(state) {
  if (state.config.mode === "error") return "config_error";
  if (state.surface === "register" && state.device) {
    return state.registerSession ? "register" : "register_locked";
  }
  if (!state.session) return "signed_out";
  if (!state.me) return "loading";
  if (state.me.stores.length === 0 || !state.tenantId) return "no_store";
  return "backoffice";
}

// The credential the API client should send right now.
export function currentAuth(state) {
  if (state.surface === "register" && state.device) {
    return {
      kind: "device",
      secret: state.device.secret,
      sessionToken: state.registerSession ? state.registerSession.token : null,
    };
  }
  if (state.session) {
    return { kind: "bearer", token: state.session.accessToken, tenantId: state.tenantId };
  }
  return null;
}

export function currentStore(state) {
  if (!state.me || !state.tenantId) return null;
  return state.me.stores.find((s) => s.tenant_id === state.tenantId) || null;
}
