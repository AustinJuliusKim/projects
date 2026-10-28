import { useState } from "react";
import { Alert, Button, PasswordInput, Stack, Text } from "@mantine/core";

import { setMyPin } from "./api.js";
import { buildPinBody } from "./forms.js";

// PUT /v1/me/pin: your PIN for this store's registers (sign-in and
// approvals). Only while signed in with your own account.
export default function PinPage({ ctx }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const { body, error: formError } = buildPinBody(pin, confirm);
    if (formError) return setError(formError);
    setBusy(true);
    try {
      await setMyPin(body.pin);
      setDone(true);
      setPin("");
      setConfirm("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const digits = (v) => v.replace(/\D/g, "").slice(0, 6);

  return (
    <form onSubmit={submit}>
      <Stack maw={360}>
        <Text size="sm" c="dimmed">
          Your 6-digit PIN for {ctx.store ? ctx.store.name : "this store"}&apos;s registers: you sign
          in with it, and managers approve with it. Setting a new one clears a lockout.
        </Text>
        <PasswordInput
          label="New PIN"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(digits(e.currentTarget.value))}
        />
        <PasswordInput
          label="Repeat it"
          inputMode="numeric"
          autoComplete="off"
          value={confirm}
          onChange={(e) => setConfirm(digits(e.currentTarget.value))}
        />
        {error && <Alert color="red">{error}</Alert>}
        {done && <Alert color="green">PIN saved.</Alert>}
        <Button type="submit" loading={busy} w={160}>
          Save PIN
        </Button>
      </Stack>
    </form>
  );
}
