import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Stack, Table, Text, TextInput, Title } from "@mantine/core";

import { createRegister, enrollDevice, listDevices, listRegisters, revokeDevice } from "./api.js";
import { buildRegisterBody } from "./forms.js";
import { isUuid } from "./receive.js";
import { deviceFromEnrollment } from "./register.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

// Registers and their enrolled devices (registers.manage). "Enroll this
// device" turns this browser into that register: the device secret is
// returned once and kept in localStorage, and the back-office session that
// enrolled it ends (the browser is a shared machine from then on).
export default function RegistersPage({ ctx }) {
  const [registers, setRegisters] = useState(null);
  const [devices, setDevices] = useState([]);
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState(ctx.locationId || "");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const thisDevice = ctx.device && ctx.device.tenantId === ctx.tenantId ? ctx.device : null;

  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([listRegisters(), listDevices()]);
      setRegisters(r);
      setDevices(d);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(key, fn) {
    setError(null);
    setNotice(null);
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
    const { body, error: formError } = buildRegisterBody({ locationId, name }, isUuid);
    if (formError) return setError(formError);
    act("create", async () => {
      await createRegister(body);
      setName("");
    });
  }

  function enroll(register) {
    const replacing = ctx.device
      ? `This browser is already enrolled as "${ctx.device.registerName}"; that enrollment will be replaced. `
      : "";
    if (
      !window.confirm(
        `${replacing}Enroll this browser as the register "${register.name}"? ` +
          "It becomes a shared register and you will be signed out of the back office here.",
      )
    ) {
      return;
    }
    act(`enroll:${register.id}`, async () => {
      const enrolled = await enrollDevice(register.id);
      // Hands the browser over to the register: ends this back-office
      // session (App.deviceEnrolled), so we leave this page.
      await ctx.onDeviceEnrolled(
        deviceFromEnrollment(enrolled, {
          register,
          tenantId: ctx.tenantId,
          storeName: ctx.store && ctx.store.name,
        }),
      );
    });
  }

  function revoke(device) {
    act(`revoke:${device.id}`, async () => {
      await revokeDevice(device.id);
      if (thisDevice && thisDevice.deviceId === device.id) {
        ctx.dispatch({ type: "device_forgotten", notice: "This browser's register enrollment was revoked." });
      }
    });
  }

  if (!registers && !error) return <Loader size="sm" />;

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

      <Title order={4}>Registers</Title>
      {registers && registers.length === 0 && (
        <Text c="dimmed" size="sm">
          No registers yet.
        </Text>
      )}
      {registers && registers.length > 0 && (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Location</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {registers.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>{r.name}</Table.Td>
                <Table.Td ff="monospace">{r.location_id}</Table.Td>
                <Table.Td>{when(r.created_at)}</Table.Td>
                <Table.Td>
                  <Button size="xs" variant="light" loading={busy === `enroll:${r.id}`} onClick={() => enroll(r)}>
                    Enroll this device
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <form onSubmit={create}>
        <Group align="flex-end">
          <TextInput label="New register" placeholder="Front counter" value={name} onChange={(e) => setName(e.currentTarget.value)} w={220} />
          <TextInput
            label="Location ID"
            value={locationId}
            onChange={(e) => setLocationId(e.currentTarget.value.trim())}
            w={340}
          />
          <Button type="submit" loading={busy === "create"}>
            Create
          </Button>
        </Group>
      </form>

      <Title order={4}>Devices</Title>
      {devices.length === 0 ? (
        <Text c="dimmed" size="sm">
          No devices enrolled.
        </Text>
      ) : (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Register</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Enrolled</Table.Th>
              <Table.Th>Last seen</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {devices.map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td>
                  {d.register_name}{" "}
                  {thisDevice && thisDevice.deviceId === d.id && (
                    <Badge size="xs" variant="outline">
                      this device
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge color={d.status === "active" ? "green" : "gray"} variant="light">
                    {d.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{when(d.enrolled_at)}</Table.Td>
                <Table.Td>{when(d.last_seen_at)}</Table.Td>
                <Table.Td>
                  {d.status === "active" && (
                    <Button size="xs" color="red" variant="light" loading={busy === `revoke:${d.id}`} onClick={() => revoke(d)}>
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
