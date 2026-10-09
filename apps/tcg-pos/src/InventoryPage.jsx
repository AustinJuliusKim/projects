import { useEffect, useState } from "react";
import { Alert, Group, Loader, Pagination, Stack, Table, Text, TextInput } from "@mantine/core";

import { isAbortError, listInventory } from "./api.js";
import { displayCents } from "./money.js";

const PAGE_SIZE = 50;

// TODO(auth): the tenant is typed in by hand until login supplies it.
export default function InventoryPage() {
  const [tenantId, setTenantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tenantId) {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    listInventory(
      { location_id: locationId, page, page_size: PAGE_SIZE },
      { tenantId, signal: ctrl.signal },
    )
      .then(setData)
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      })
      // An aborted request was superseded by a newer one (or the tenant was
      // cleared); leave the spinner to whoever is current.
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [tenantId, locationId, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Stack>
      <Group align="flex-end">
        <TextInput
          label="Tenant ID"
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.currentTarget.value.trim());
            setPage(1);
          }}
          w={340}
        />
        <TextInput
          label="Location ID (optional)"
          value={locationId}
          onChange={(e) => {
            setLocationId(e.currentTarget.value.trim());
            setPage(1);
          }}
          w={340}
        />
        {loading && <Loader size="sm" />}
      </Group>

      {error && <Alert color="red">{error}</Alert>}
      {!tenantId && <Text c="dimmed">Enter a tenant ID to load inventory.</Text>}

      {data && (
        <>
          <Text size="sm" c="dimmed">
            {data.total} item{data.total === 1 ? "" : "s"}
          </Text>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Printing</Table.Th>
                <Table.Th>Condition</Table.Th>
                <Table.Th>Finish</Table.Th>
                <Table.Th>Lang</Table.Th>
                <Table.Th ta="right">Qty</Table.Th>
                <Table.Th ta="right">Price</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.items.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td ff="monospace">{item.printing_id}</Table.Td>
                  <Table.Td>{item.condition}</Table.Td>
                  <Table.Td>{item.finish}</Table.Td>
                  <Table.Td>{item.lang}</Table.Td>
                  <Table.Td ta="right">{item.qty}</Table.Td>
                  <Table.Td ta="right">{displayCents(item.price_cents, { fallback: "unpriced" })}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} />}
        </>
      )}
    </Stack>
  );
}
