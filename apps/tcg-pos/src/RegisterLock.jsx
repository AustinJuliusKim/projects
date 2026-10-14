import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";

import { registerSignIn, registerStaff } from "./api.js";
import { registerSessionFrom } from "./authState.js";
import PinPad from "./PinPad.jsx";
import { pinFailure } from "./register.js";
import useCountdown from "./useCountdown.js";

// The locked register: pick your name, enter your PIN. A wrong PIN says how
// many tries are left; a locked PIN (423) or a rate-limited device (429)
// disables the pad with a countdown.
export default function RegisterLock({ device, notice, dispatch }) {
  const [staff, setStaff] = useState(null);
  const [error, setError] = useState(null);
  const [person, setPerson] = useState(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const wait = useCountdown(failure && failure.lockedUntil);

  const load = useCallback(() => {
    setError(null);
    // A revoked device answers 401 device_unknown, which the API client
    // turns into "enroll again" (back to the back office).
    registerStaff()
      .then(setStaff)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  async function signIn() {
    setBusy(true);
    setFailure(null);
    try {
      const r = await registerSignIn(person.user_id, pin);
      dispatch({ type: "register_signed_in", registerSession: registerSessionFrom(r) });
    } catch (e) {
      setFailure(pinFailure(e));
      setPin("");
      setBusy(false);
    }
  }

  function pick(p) {
    setPerson(p);
    setPin("");
    setFailure(null);
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" w={520}>
        <Stack>
          <Group justify="space-between">
            <div>
              <Title order={3}>{device.registerName || "Register"}</Title>
              {device.storeName && (
                <Text size="sm" c="dimmed">
                  {device.storeName}
                </Text>
              )}
            </div>
            <Button variant="subtle" size="xs" onClick={() => dispatch({ type: "surface", surface: "backoffice" })}>
              Back office
            </Button>
          </Group>
          {notice && <Alert color="yellow">{notice}</Alert>}
          {error && (
            <Alert color="red">
              {error}{" "}
              <Button size="xs" variant="subtle" onClick={load}>
                Retry
              </Button>
            </Alert>
          )}
          {!staff && !error && <Loader size="sm" />}
          {staff && staff.length === 0 && (
            <Text c="dimmed">
              Nobody can sign in here yet: each person sets a PIN under My PIN in the back office.
            </Text>
          )}
          {staff && !person && staff.length > 0 && (
            <>
              <Text>Who&apos;s signing in?</Text>
              <SimpleGrid cols={{ base: 2, xs: 3 }} spacing="xs">
                {staff.map((s) => (
                  <Button key={s.user_id} variant="default" size="lg" onClick={() => pick(s)}>
                    <Stack gap={0} align="center">
                      <span>{s.name}</span>
                      <Text size="xs" c="dimmed">
                        {s.role}
                      </Text>
                    </Stack>
                  </Button>
                ))}
              </SimpleGrid>
            </>
          )}
          {person && (
            <Stack align="center">
              <Group>
                <Text fw={500}>{person.name}</Text>
                <Button variant="subtle" size="xs" onClick={() => pick(null)}>
                  Not you?
                </Button>
              </Group>
              {failure && (
                <Alert color={wait > 0 ? "orange" : "red"} w="100%">
                  {wait > 0 ? `${failure.message} Try again in ${wait}s.` : failure.message}
                </Alert>
              )}
              <PinPad value={pin} onChange={setPin} onSubmit={signIn} disabled={wait > 0 || busy} busy={busy} />
            </Stack>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
