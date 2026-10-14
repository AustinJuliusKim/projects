import { useEffect, useMemo, useRef } from "react";
import { Alert, Button, Group, Text, Title } from "@mantine/core";

import { registerSignOut } from "./api.js";
import { ApprovalProvider } from "./Approval.jsx";
import { visibleNav } from "./perms.js";
import { createIdleTimer } from "./register.js";
import Workspace from "./Workspace.jsx";

const ACTIVITY = ["pointerdown", "keydown", "touchstart", "wheel"];

// A staff member signed in on the register: the store pages under their
// perms (from the session), an explicit Lock, and an idle auto-lock at the
// server's idle timeout (the server enforces it too: session_idle).
export default function RegisterMode({ state, dispatch }) {
  const { device, registerSession: rs } = state;
  const perms = useMemo(() => new Set(rs.perms), [rs.perms]);
  const locking = useRef(false);

  function lock(notice) {
    if (locking.current) return;
    locking.current = true;
    // End it server-side too (best effort: an already-idle session 401s,
    // which locks the screen anyway).
    registerSignOut()
      .catch(() => {})
      .finally(() => dispatch({ type: "register_locked", notice }));
  }
  const lockRef = useRef(lock);
  lockRef.current = lock;

  useEffect(() => {
    const minutes = Math.round(rs.idleTimeoutSeconds / 60);
    const timer = createIdleTimer({
      timeoutMs: rs.idleTimeoutSeconds * 1000,
      onIdle: () => lockRef.current(`Locked after ${minutes} minutes without activity.`),
    });
    const touch = () => timer.touch();
    for (const ev of ACTIVITY) window.addEventListener(ev, touch, { passive: true });
    // The session's absolute expiry (12 h) as well.
    const expiry = rs.expiresAt
      ? setTimeout(() => lockRef.current("The register session expired."), Math.max(0, rs.expiresAt - Date.now()))
      : null;
    return () => {
      timer.stop();
      for (const ev of ACTIVITY) window.removeEventListener(ev, touch);
      if (expiry) clearTimeout(expiry);
    };
  }, [rs.token, rs.idleTimeoutSeconds, rs.expiresAt]);

  const ctx = {
    tenantId: device.tenantId,
    locationId: device.locationId || "",
    setLocationId: () => {},
    locationFixed: true,
    perms,
    roleKey: rs.role,
    surface: "register",
    store: device.storeName ? { name: device.storeName, tenant_id: device.tenantId } : null,
    me: null,
    device,
    dispatch,
  };

  const header = (
    <Group justify="space-between" w="100%" wrap="nowrap">
      <Title order={4}>{device.registerName || "Register"}</Title>
      <Group wrap="nowrap">
        <Text size="sm">
          {rs.name} <Text span c="dimmed">({rs.role})</Text>
        </Text>
        <Button size="xs" onClick={() => lock(null)}>
          Lock
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
    <ApprovalProvider requester={rs}>
      <Workspace key={rs.token} header={header} nav={visibleNav(perms, "register")} ctx={ctx} banner={banner} />
    </ApprovalProvider>
  );
}
