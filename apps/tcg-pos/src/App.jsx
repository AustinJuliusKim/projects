import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  MantineProvider,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";

import { configureApi, devLogin, getMe, listRoles, syncIdentity } from "./api.js";
import { ApprovalProvider } from "./Approval.jsx";
import {
  beginCognitoSignIn,
  completeCognitoSignIn,
  devSignIn,
  ensureFresh,
  inviteTokenFrom,
  signOutUrl,
} from "./auth.js";
import { currentAuth, currentStore, initialState, reducer, screen } from "./authState.js";
import CreateStore from "./CreateStore.jsx";
import InviteAccept from "./InviteAccept.jsx";
import { permsForRole, SYSTEM_ROLE_PERMS, visibleNav } from "./perms.js";
import RegisterLock from "./RegisterLock.jsx";
import RegisterMode from "./RegisterMode.jsx";
import {
  authConfig,
  DEVICE_KEY,
  INVITE_KEY,
  LOCATION_KEY,
  readJson,
  REGISTER_SESSION_KEY,
  SESSION_KEY,
  sessionStatus,
  STORE_KEY,
  SURFACE_KEY,
  writeJson,
} from "./session.js";
import SignInScreen, { ConfigError } from "./SignInScreen.jsx";
import Workspace from "./Workspace.jsx";

const CONFIG = authConfig(import.meta.env);
if (CONFIG.mode === "error") console.error(`[tcg-pos] ${CONFIG.error}`);

const local = typeof localStorage !== "undefined" ? localStorage : undefined;
const tabStore = typeof sessionStorage !== "undefined" ? sessionStorage : undefined;

// URL work that must happen once per page load, before React (StrictMode
// runs effects twice): keep an invite token through sign-in, and finish a
// Cognito redirect.
const { pathname, search, origin } = window.location;
const inviteAtBoot = inviteTokenFrom(pathname, search);
if (inviteAtBoot) {
  writeJson(tabStore, INVITE_KEY, inviteAtBoot);
  window.history.replaceState(null, "", "/");
}
const callback =
  CONFIG.mode === "cognito" && pathname === CONFIG.redirectPath
    ? completeCognitoSignIn(CONFIG, search, { origin, sessionStore: tabStore, syncIdentity })
    : null;
if (callback) window.history.replaceState(null, "", "/");

function boot() {
  const session = readJson(local, SESSION_KEY);
  return initialState({
    config: CONFIG,
    // An expired dev token is just signed out; a Cognito one may refresh.
    session: sessionStatus(session) === "expired" ? null : session,
    tenantId: readJson(local, STORE_KEY),
    device: readJson(local, DEVICE_KEY),
    registerSession: readJson(tabStore, REGISTER_SESSION_KEY),
    surface: readJson(local, SURFACE_KEY) || "backoffice",
  });
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, boot);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [invite, setInvite] = useState(() => readJson(tabStore, INVITE_KEY));
  const [meError, setMeError] = useState(null);
  const [meAttempt, setMeAttempt] = useState(0);

  // The API client asks for the credential per request. Installed during
  // the first render so child effects' first requests already have it.
  const configured = useRef(false);
  if (!configured.current) {
    configured.current = true;
    let refreshing = null;
    configureApi({
      getAuth: async () => {
        const s = stateRef.current;
        const auth = currentAuth(s);
        if (!auth || auth.kind !== "bearer") return auth;
        if (sessionStatus(s.session) === "fresh") return auth;
        refreshing = refreshing || ensureFresh(s.session, CONFIG).finally(() => (refreshing = null));
        const fresh = await refreshing;
        if (!fresh) {
          dispatch({ type: "signed_out", notice: "Your sign-in expired. Sign in again." });
          return null;
        }
        dispatch({ type: "session_refreshed", session: fresh });
        stateRef.current = { ...stateRef.current, session: fresh };
        return { ...auth, token: fresh.accessToken };
      },
      onAuthFailure: (failure) => dispatch({ type: "auth_failure", ...failure }),
    });
  }

  // Persist what survives a reload. The register session is per tab.
  useEffect(() => writeJson(local, SESSION_KEY, state.session), [state.session]);
  useEffect(() => writeJson(local, STORE_KEY, state.tenantId), [state.tenantId]);
  useEffect(() => writeJson(local, DEVICE_KEY, state.device), [state.device]);
  useEffect(() => writeJson(local, SURFACE_KEY, state.surface), [state.surface]);
  useEffect(
    () => writeJson(tabStore, REGISTER_SESSION_KEY, state.registerSession),
    [state.registerSession],
  );
  useEffect(() => writeJson(tabStore, INVITE_KEY, invite), [invite]);

  useEffect(() => {
    if (!callback) return;
    callback
      .then(({ session, me }) => {
        dispatch({ type: "signed_in", session });
        dispatch({ type: "me_loaded", me });
      })
      .catch((e) => dispatch({ type: "notice", notice: e.message }));
  }, []);

  const view = screen(state);

  useEffect(() => {
    if (view !== "loading") return undefined;
    let live = true;
    setMeError(null);
    getMe()
      .then((me) => live && dispatch({ type: "me_loaded", me }))
      .catch((e) => live && setMeError(e.message));
    return () => {
      live = false;
    };
  }, [view, meAttempt]);

  function signOut() {
    const url = signOutUrl(CONFIG, state.session, origin);
    dispatch({ type: "signed_out" });
    writeJson(local, SESSION_KEY, null);
    if (url) window.location.assign(url);
  }

  async function signInDev(email, name) {
    const { session, me } = await devSignIn(email, name, { devLogin, syncIdentity });
    dispatch({ type: "signed_in", session });
    dispatch({ type: "me_loaded", me });
  }

  async function signInCognito() {
    window.location.assign(await beginCognitoSignIn(CONFIG, { origin, sessionStore: tabStore }));
  }

  async function inviteAccepted(joined) {
    const me = await getMe();
    dispatch({ type: "me_loaded", me });
    dispatch({ type: "store_selected", tenantId: joined.tenant_id });
    setInvite(null);
  }

  const openRegister = state.device ? () => dispatch({ type: "surface", surface: "register" }) : null;

  let body;
  if (view === "config_error") {
    body = <ConfigError error={CONFIG.error} />;
  } else if (view === "signed_out") {
    body = (
      <SignInScreen
        config={CONFIG}
        notice={state.notice}
        invited={Boolean(invite)}
        onCognito={signInCognito}
        onDevSignIn={signInDev}
        onOpenRegister={openRegister}
      />
    );
  } else if (view === "loading") {
    body = (
      <Center mih="100vh">
        {meError ? (
          <Stack align="center">
            <Alert color="red">{meError}</Alert>
            <Group>
              <Button onClick={() => setMeAttempt((n) => n + 1)}>Retry</Button>
              <Button variant="default" onClick={signOut}>
                Sign out
              </Button>
            </Group>
          </Stack>
        ) : (
          <Loader />
        )}
      </Center>
    );
  } else if (invite && (view === "backoffice" || view === "no_store")) {
    body = (
      <InviteAccept
        token={invite}
        email={state.me.user.email}
        onAccepted={inviteAccepted}
        onDismiss={() => setInvite(null)}
      />
    );
  } else if (view === "no_store") {
    body = (
      <Center mih="100vh" p="md">
        <Paper withBorder p="xl" w={460}>
          <Stack>
            <Title order={3}>Create your store</Title>
            <Text size="sm">
              {state.me.user.email} isn&apos;t a member of any store yet. Create one, or ask a
              store&apos;s owner for an invite link.
            </Text>
            <CreateStore onCreated={(store) => dispatch({ type: "store_created", store })} />
            <Button variant="subtle" onClick={signOut}>
              Sign out
            </Button>
          </Stack>
        </Paper>
      </Center>
    );
  } else if (view === "backoffice") {
    body = <BackOffice state={state} dispatch={dispatch} onSignOut={signOut} onOpenRegister={openRegister} />;
  } else if (view === "register_locked") {
    body = <RegisterLock device={state.device} notice={state.notice} dispatch={dispatch} />;
  } else {
    body = <RegisterMode state={state} dispatch={dispatch} />;
  }

  return <MantineProvider defaultColorScheme="auto">{body}</MantineProvider>;
}

// Locations are remembered per store (there's no locations endpoint yet).
function useStoreLocation(tenantId) {
  const [all, setAll] = useState(() => readJson(local, LOCATION_KEY) || {});
  const locationId = (tenantId && all[tenantId]) || "";
  function setLocationId(value) {
    const next = { ...all, [tenantId]: value };
    setAll(next);
    writeJson(local, LOCATION_KEY, next);
  }
  return [locationId, setLocationId];
}

// Perms for the selected store. /v1/me only says the role: system roles are
// mirrored client-side; a store-defined role needs GET /v1/roles, which only
// staff.manage can read — otherwise unknown (show all, the API decides).
function useStorePerms(store) {
  const [roles, setRoles] = useState(null);
  const role = store ? store.role : null;
  const tenantId = store ? store.tenant_id : null;
  useEffect(() => {
    setRoles(null);
    if (!role || SYSTEM_ROLE_PERMS[role]) return undefined;
    let live = true;
    listRoles()
      .then((r) => live && setRoles(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tenantId, role]);
  return useMemo(() => (role ? permsForRole(role, roles) : null), [role, roles]);
}

function BackOffice({ state, dispatch, onSignOut, onOpenRegister }) {
  const store = currentStore(state);
  const perms = useStorePerms(store);
  const [locationId, setLocationId] = useStoreLocation(state.tenantId);
  const [creating, setCreating] = useState(false);
  const deviceHere = state.device && state.device.tenantId === state.tenantId;

  const ctx = {
    tenantId: state.tenantId,
    locationId,
    setLocationId,
    locationFixed: false,
    perms,
    roleKey: store ? store.role : null,
    surface: "backoffice",
    store,
    me: state.me,
    device: state.device,
    dispatch,
  };

  const header = (
    <Group justify="space-between" w="100%" wrap="nowrap">
      <Group wrap="nowrap">
        <Title order={3} visibleFrom="xs">
          TCG POS
        </Title>
        <Select
          aria-label="Store"
          data={state.me.stores.map((s) => ({
            value: s.tenant_id,
            label: `${s.name} · ${s.role_name}`,
          }))}
          value={state.tenantId}
          onChange={(v) => v && dispatch({ type: "store_selected", tenantId: v })}
          allowDeselect={false}
          w={260}
        />
        <Button variant="subtle" size="xs" onClick={() => setCreating(true)}>
          New store
        </Button>
      </Group>
      <Group wrap="nowrap">
        {deviceHere && onOpenRegister && (
          <Button size="xs" variant="light" onClick={onOpenRegister}>
            Register mode
          </Button>
        )}
        <Text size="sm" c="dimmed" visibleFrom="md">
          {state.me.user.display_name || state.me.user.email}
        </Text>
        <Button size="xs" variant="default" onClick={onSignOut}>
          Sign out
        </Button>
      </Group>
    </Group>
  );

  const banner = state.notice && (
    <Alert color="yellow" mb="md" withCloseButton onClose={() => dispatch({ type: "notice" })}>
      {state.notice}
    </Alert>
  );

  return (
    <ApprovalProvider requester={null}>
      <Workspace
        key={state.tenantId}
        header={header}
        nav={visibleNav(perms, "backoffice")}
        ctx={ctx}
        banner={banner}
      />
      <Modal opened={creating} onClose={() => setCreating(false)} title="New store">
        <CreateStore
          onCreated={(s) => {
            setCreating(false);
            dispatch({ type: "store_created", store: s });
          }}
          onCancel={() => setCreating(false)}
        />
      </Modal>
    </ApprovalProvider>
  );
}
