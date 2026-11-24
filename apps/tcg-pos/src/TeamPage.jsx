import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";

import {
  createInvite,
  disableStaff,
  listInvites,
  listRoles,
  listStaff,
  revokeInvite,
  updateStaff,
} from "./api.js";
import { buildInviteBody } from "./forms.js";
import { canGrant } from "./perms.js";

const STATUS_COLOR = { active: "green", disabled: "gray", pending: "blue", accepted: "green", revoked: "gray", expired: "yellow" };

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

// Staff, invites and roles (staff.manage). Role menus only offer what the
// API's escalation rule would allow (perms.canGrant); the API still checks
// and its 403s are shown as they come.
export default function TeamPage({ ctx }) {
  const [staff, setStaff] = useState(null);
  const [invites, setInvites] = useState([]);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("cashier");
  const [busy, setBusy] = useState(null);

  const me = ctx.me.user.id;
  const grantable = roles.filter((r) => canGrant(r, ctx.perms, ctx.roleKey));
  const roleOf = (key) => roles.find((r) => r.key === key);

  const load = useCallback(async () => {
    try {
      const [s, i, r] = await Promise.all([listStaff(), listInvites(), listRoles()]);
      setStaff(s);
      setInvites(i);
      setRoles(r);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(key, fn, done) {
    setError(null);
    setNotice(null);
    setBusy(key);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  function invite(e) {
    e.preventDefault();
    const { body, error: formError } = buildInviteBody({ email, role: inviteRole });
    if (formError) return setError(formError);
    act(
      "invite",
      async () => {
        await createInvite(body);
        setEmail("");
      },
      `Invited ${body.email} as ${body.role}. Invite email isn't wired up yet: the accept link ` +
        "(/invite?token=…) is written to the API's log in local dev. Pending invites expire in 7 days.",
    );
  }

  if (!staff && !error) return <Loader size="sm" />;

  return (
    <Stack maw={960}>
      {error && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert color="green" withCloseButton onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <Title order={4}>Staff</Title>
      {staff && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Role</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {staff.map((m) => {
              const self = m.user_id === me;
              const manageable = !self && canGrant(roleOf(m.role), ctx.perms, ctx.roleKey);
              return (
                <Table.Tr key={m.user_id}>
                  <Table.Td>
                    {m.display_name || "—"}
                    <Text size="xs" c="dimmed">
                      {m.email || m.user_id}
                      {self ? " (you)" : ""}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {manageable ? (
                      <Select
                        aria-label={`Role for ${m.email}`}
                        data={grantable.map((r) => ({ value: r.key, label: r.name }))}
                        value={m.role}
                        allowDeselect={false}
                        w={160}
                        disabled={busy !== null}
                        onChange={(role) =>
                          role &&
                          role !== m.role &&
                          act(`role:${m.user_id}`, () => updateStaff(m.user_id, { role }), `Role changed to ${role}.`)
                        }
                      />
                    ) : (
                      m.role_name
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[m.status]} variant="light">
                      {m.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {manageable && m.status === "active" && (
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        loading={busy === `status:${m.user_id}`}
                        onClick={() => act(`status:${m.user_id}`, () => disableStaff(m.user_id), "Disabled.")}
                      >
                        Disable
                      </Button>
                    )}
                    {manageable && m.status === "disabled" && (
                      <Button
                        size="xs"
                        variant="light"
                        loading={busy === `status:${m.user_id}`}
                        onClick={() =>
                          act(`status:${m.user_id}`, () => updateStaff(m.user_id, { status: "active" }), "Re-enabled.")
                        }
                      >
                        Enable
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}

      <Title order={4}>Invite</Title>
      <form onSubmit={invite}>
        <Group align="flex-end">
          <TextInput label="Email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} w={280} />
          <Select
            label="Role"
            data={grantable.map((r) => ({ value: r.key, label: r.name }))}
            value={inviteRole}
            onChange={setInviteRole}
            w={180}
          />
          <Button type="submit" loading={busy === "invite"}>
            Send invite
          </Button>
        </Group>
      </form>

      <Title order={4}>Invites</Title>
      {invites.length === 0 ? (
        <Text c="dimmed" size="sm">
          No invites yet.
        </Text>
      ) : (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Email</Table.Th>
              <Table.Th>Role</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Expires</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {invites.map((i) => (
              <Table.Tr key={i.id}>
                <Table.Td>{i.email}</Table.Td>
                <Table.Td>{i.role}</Table.Td>
                <Table.Td>
                  <Badge color={STATUS_COLOR[i.status]} variant="light">
                    {i.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{when(i.expires_at)}</Table.Td>
                <Table.Td>
                  {i.status === "pending" && (
                    <Button
                      size="xs"
                      variant="light"
                      color="red"
                      loading={busy === `revoke:${i.id}`}
                      onClick={() => act(`revoke:${i.id}`, () => revokeInvite(i.id), "Invite revoked.")}
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
