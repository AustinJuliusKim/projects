import { useState } from "react";
import { Alert, Button, Center, Paper, Stack, Text, TextInput, Title } from "@mantine/core";

// Signed out. Cognito builds send the browser to the hosted UI; dev builds
// (VITE_AUTH_MODE=dev or no Cognito env) show a dev login form instead.
export default function SignInScreen({ config, notice, invited, onCognito, onDevSignIn, onOpenRegister }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(fn) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" w={420}>
        <Stack>
          <Title order={2}>TCG POS</Title>
          {notice && <Alert color="yellow">{notice}</Alert>}
          {invited && <Alert color="blue">Sign in to accept your store invite.</Alert>}
          {config.mode === "cognito" ? (
            <Button onClick={() => run(onCognito)} loading={busy}>
              Sign in
            </Button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(() => onDevSignIn(email, name));
              }}
            >
              <Stack>
                <Text size="sm" c="dimmed">
                  Dev login (local API only). Demo store: owner@demo.test or cashier@demo.test.
                </Text>
                <TextInput
                  label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  autoFocus
                />
                <TextInput
                  label="Name (optional)"
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                />
                <Button type="submit" loading={busy}>
                  Dev sign in
                </Button>
              </Stack>
            </form>
          )}
          {error && <Alert color="red">{error}</Alert>}
          {onOpenRegister && (
            <Button variant="default" onClick={onOpenRegister}>
              Open register mode
            </Button>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}

export function ConfigError({ error }) {
  return (
    <Center mih="100vh" p="md">
      <Alert color="red" title="TCG POS can't start" maw={520}>
        {error}
      </Alert>
    </Center>
  );
}
