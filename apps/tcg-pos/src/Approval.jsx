import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";

import { createApproval, registerStaff } from "./api.js";
import { approverChoices, submitApproval, withApproval } from "./approval.js";
import { displayCents } from "./money.js";
import PinPad from "./PinPad.jsx";
import useCountdown from "./useCountdown.js";

const ApprovalContext = createContext(null);

// useApproval()(send): runs send(null); on 403 approval_required opens the
// approval modal, then calls send(approvalId) once. `send` must make the
// identical request both times.
export function useApproval() {
  return useContext(ApprovalContext);
}

// Approvals only exist on an enrolled register (`requester` = the signed-in
// register session); in the back office a gated request explains that.
export function ApprovalProvider({ requester, children }) {
  const [pending, setPending] = useState(null); // { need, resolve }

  const requestApproval = useCallback(
    (need) =>
      new Promise((resolve, reject) => {
        if (!requester) {
          reject(
            new Error(
              "This needs a manager's approval, which only works on an enrolled register: " +
                "sign in there and have a manager approve with their PIN.",
            ),
          );
          return;
        }
        setPending({ need, resolve });
      }),
    [requester],
  );

  const run = useCallback((send) => withApproval(send, requestApproval), [requestApproval]);

  return (
    <ApprovalContext.Provider value={run}>
      {children}
      {pending && (
        <ApprovalModal
          need={pending.need}
          requester={requester}
          onDone={(approvalId) => {
            pending.resolve(approvalId);
            setPending(null);
          }}
        />
      )}
    </ApprovalContext.Provider>
  );
}

function ApprovalModal({ need, requester, onDone }) {
  const [staff, setStaff] = useState(null);
  const [approver, setApprover] = useState(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const wait = useCountdown(failure && failure.until);

  useEffect(() => {
    registerStaff()
      .then((s) => setStaff(approverChoices(s, requester.userId)))
      .catch((e) => setFailure({ error: e.message }));
  }, [requester.userId]);

  async function approve() {
    setBusy(true);
    setFailure(null);
    const result = await submitApproval(need, approver, pin, createApproval);
    setBusy(false);
    if (result.approvalId) return onDone(result.approvalId);
    setPin("");
    setFailure({
      ...result,
      until: result.retryAfter ? Date.now() + result.retryAfter * 1000 : null,
    });
  }

  return (
    <Modal opened onClose={() => onDone(null)} title="Manager approval" centered>
      <Stack>
        <Text size="sm">
          {requester.name} needs approval for <b>{need.perm}</b>
          {need.amountCents !== null ? ` (${displayCents(need.amountCents)})` : ""}. A manager
          picks their name and enters their PIN.
        </Text>
        <Select
          label="Approver"
          placeholder={staff ? "Pick a manager" : "Loading…"}
          data={(staff || []).map((s) => ({ value: s.user_id, label: `${s.name} · ${s.role}` }))}
          value={approver}
          onChange={setApprover}
        />
        {failure && (
          <Alert color={failure.kind === "self_approval" || failure.kind === "approver_not_allowed" ? "orange" : "red"}>
            {failure.error}
            {wait > 0 ? ` Try again in ${wait}s.` : ""}
          </Alert>
        )}
        <PinPad
          value={pin}
          onChange={setPin}
          onSubmit={approve}
          disabled={!approver || busy || wait > 0}
          busy={busy}
          submitLabel="Approve"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
