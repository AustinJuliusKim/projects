import { useState } from "react";
import { Alert, Button, Center, Group, Paper, Stack, Text, Title } from "@mantine/core";

import { acceptInvite } from "./api.js";

// /invite?token=... — the token was kept through sign-in; accepting joins
// the invite's store (POST /v1/invites/accept). The API checks the invite's
// email against the signed-in account's verified email.
export default function InviteAccept({ token, email, onAccepted, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function accept() {
    setError(null);
    setBusy(true);
    try {
      const joined = await acceptInvite(token);
      await onAccepted(joined);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" w={460}>
        <Stack>
          <Title order={3}>Store invite</Title>
          <Text>
            Accept the invite as <b>{email || "this account"}</b>? It only works for the email
            address it was sent to.
          </Text>
          {error && <Alert color="red">{error}</Alert>}
          <Group>
            <Button onClick={accept} loading={busy}>
              Accept invite
            </Button>
            <Button variant="default" onClick={onDismiss}>
              Not now
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Center>
  );
}
