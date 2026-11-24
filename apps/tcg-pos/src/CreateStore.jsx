import { useState } from "react";
import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";

import { createStore } from "./api.js";
import { buildStoreBody } from "./forms.js";

// POST /v1/stores: a new store + its first location, with the caller as
// owner. Shown when the user has no store, and from the store switcher.
export default function CreateStore({ onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const { body, error: formError } = buildStoreBody({ name, locationName });
    if (formError) return setError(formError);
    setBusy(true);
    try {
      onCreated(await createStore(body));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Stack>
        <Text size="sm" c="dimmed">
          You&apos;ll be the store&apos;s owner. Invite staff from the Team page afterwards.
        </Text>
        <TextInput label="Store name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <TextInput
          label="First location"
          placeholder="Main"
          value={locationName}
          onChange={(e) => setLocationName(e.currentTarget.value)}
        />
        {error && <Alert color="red">{error}</Alert>}
        <Group>
          <Button type="submit" loading={busy}>
            Create store
          </Button>
          {onCancel && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Group>
      </Stack>
    </form>
  );
}
