import { useState } from "react";
import { Alert, Button, Group, SegmentedControl, Stack, Text, TextInput, Title } from "@mantine/core";

import { adjustCredit, getCredit } from "./api.js";
import { ApprovalCancelled } from "./approval.js";
import { useApproval } from "./Approval.jsx";
import { buildCreditAdjust } from "./forms.js";
import { displayCents } from "./money.js";
import { can } from "./perms.js";
import { isUuid } from "./receive.js";

// Store credit: look a customer up by ID (the API has no customer search
// yet), see the balance (credit.read) and adjust it ± with a reason. Adjust
// is approval-gated for cashiers: the API answers approval_required and
// useApproval() runs the manager-PIN modal and the retry.
export default function CreditPage({ ctx }) {
  const runWithApproval = useApproval();
  const [customerId, setCustomerId] = useState("");
  const [balance, setBalance] = useState(null); // { customer_id, balance_cents }
  const [direction, setDirection] = useState("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function lookUp(e) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setBalance(null);
    if (!isUuid(customerId)) return setError("Enter the customer's ID (UUID).");
    setBusy(true);
    try {
      setBalance(await getCredit(customerId.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function adjust(e) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const { body, error: formError } = buildCreditAdjust({ direction, amount, reason });
    if (formError) return setError(formError);
    setBusy(true);
    try {
      const id = balance.customer_id;
      const result = await runWithApproval((approvalId) => adjustCredit(id, body, { approvalId }));
      setBalance(result);
      setDone(`${direction === "add" ? "Added" : "Removed"} ${displayCents(Math.abs(body.delta_cents))}.`);
      setAmount("");
      setReason("");
    } catch (err) {
      setError(err instanceof ApprovalCancelled ? "Cancelled: no approval, nothing changed." : err.message);
    } finally {
      setBusy(false);
    }
  }

  // credit.adjust may be approval-gated rather than held, so the form shows
  // for anyone who can read credit; the API decides.
  const mayTry = can(ctx.perms, "credit.read");

  return (
    <Stack maw={560}>
      <form onSubmit={lookUp}>
        <Group align="flex-end">
          <TextInput
            label="Customer ID"
            value={customerId}
            onChange={(e) => setCustomerId(e.currentTarget.value.trim())}
            w={340}
          />
          <Button type="submit" variant="default" loading={busy && !balance}>
            Look up
          </Button>
        </Group>
      </form>

      {balance && (
        <>
          <Title order={4}>Balance: {displayCents(balance.balance_cents)}</Title>
          {mayTry && (
            <form onSubmit={adjust}>
              <Stack>
                <SegmentedControl
                  data={[
                    { value: "add", label: "Add credit" },
                    { value: "remove", label: "Remove credit" },
                  ]}
                  value={direction}
                  onChange={setDirection}
                  w={280}
                />
                <TextInput
                  label="Amount ($)"
                  value={amount}
                  onChange={(e) => setAmount(e.currentTarget.value)}
                  w={180}
                />
                <TextInput
                  label="Reason"
                  placeholder="e.g. goodwill for a damaged order"
                  value={reason}
                  onChange={(e) => setReason(e.currentTarget.value)}
                />
                <Text size="xs" c="dimmed">
                  Corrections outside a sale may need a manager&apos;s approval at the register.
                </Text>
                <Button type="submit" loading={busy} w={180}>
                  Adjust
                </Button>
              </Stack>
            </form>
          )}
        </>
      )}

      {error && <Alert color="red">{error}</Alert>}
      {done && <Alert color="green">{done}</Alert>}
    </Stack>
  );
}
