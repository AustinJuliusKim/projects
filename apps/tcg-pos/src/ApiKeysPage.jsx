import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";

import { createApiKey, listApiKeys, revokeApiKey } from "./api.js";
import { buildApiKeyBody } from "./forms.js";
import { keyGrantablePerms } from "./perms.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

// Store API keys (apikeys.manage, owners by default): integrations send
// `Authorization: ApiKey <key>`. The key is shown once, at creation. Admin
// permissions (staff, roles, registers, keys, approvals, billing) can't go
// on a key, and nor can permissions you don't hold.
export default function ApiKeysPage({ ctx }) {
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState("");
  const [perms, setPerms] = useState([]);
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setKeys(await listApiKeys());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(key, fn) {
    setError(null);
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  function create(e) {
    e.preventDefault();
    setCreated(null);
    const { body, error: formError } = buildApiKeyBody({ name, perms });
    if (formError) return setError(formError);
    act("create", async () => {
      setCreated(await createApiKey(body));
      setName("");
      setPerms([]);
    });
  }

  if (!keys && !error) return <Loader size="sm" />;

  return (
    <Stack maw={960}>
      {error && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {created && (
        <Alert color="green" title={`Key "${created.name}" created`} withCloseButton onClose={() => setCreated(null)}>
          <Stack gap="xs">
            <Text size="sm">Copy it now: it won&apos;t be shown again.</Text>
            <Group wrap="nowrap">
              <Code style={{ wordBreak: "break-all" }}>{created.key}</Code>
              <CopyButton value={created.key}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        </Alert>
      )}

      <Title order={4}>New key</Title>
      <form onSubmit={create}>
        <Stack>
          <TextInput label="Name" placeholder="Inventory sync" value={name} onChange={(e) => setName(e.currentTarget.value)} w={280} />
          <Checkbox.Group label="Permissions" value={perms} onChange={setPerms}>
            <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing={6} mt="xs">
              {keyGrantablePerms(ctx.perms).map((p) => (
                <Checkbox key={p} value={p} label={p} />
              ))}
            </SimpleGrid>
          </Checkbox.Group>
          <Button type="submit" loading={busy === "create"} w={160}>
            Create key
          </Button>
        </Stack>
      </form>

      <Title order={4}>Keys</Title>
      {keys && keys.length === 0 ? (
        <Text c="dimmed" size="sm">
          No API keys.
        </Text>
      ) : (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Prefix</Table.Th>
              <Table.Th>Permissions</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Last used</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(keys || []).map((k) => (
              <Table.Tr key={k.id}>
                <Table.Td>{k.name}</Table.Td>
                <Table.Td ff="monospace">{k.prefix}</Table.Td>
                <Table.Td>
                  <Text size="xs">{k.perms.join(", ")}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge color={k.status === "active" ? "green" : "gray"} variant="light">
                    {k.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{when(k.last_used_at)}</Table.Td>
                <Table.Td>
                  {k.status === "active" && (
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      loading={busy === `revoke:${k.id}`}
                      onClick={() => act(`revoke:${k.id}`, () => revokeApiKey(k.id))}
                    >
                      Revoke
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
