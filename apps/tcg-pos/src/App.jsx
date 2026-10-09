import { useState } from "react";
import {
  AppShell,
  Group,
  MantineProvider,
  SegmentedControl,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";

import ImportPage from "./ImportPage.jsx";
import InventoryPage from "./InventoryPage.jsx";
import ReceivePage from "./ReceivePage.jsx";

const PAGES = [
  { value: "inventory", label: "Inventory" },
  { value: "receive", label: "Receive" },
  { value: "import", label: "Import" },
];

// TODO(auth): tenant and clerk are typed in by hand until login supplies them.
export default function App() {
  const [page, setPage] = useState("inventory");
  const [tenantId, setTenantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [actor, setActor] = useState("");
  const store = { tenantId, locationId, actor };

  return (
    <MantineProvider defaultColorScheme="auto">
      <AppShell header={{ height: 56 }} padding="md">
        <AppShell.Header px="md" style={{ display: "flex", alignItems: "center" }}>
          <Group justify="space-between" w="100%">
            <Title order={3}>TCG POS</Title>
            <SegmentedControl data={PAGES} value={page} onChange={setPage} />
          </Group>
        </AppShell.Header>
        <AppShell.Main>
          <Stack>
            <Group align="flex-end">
              <TextInput
                label="Tenant ID"
                value={tenantId}
                onChange={(e) => setTenantId(e.currentTarget.value.trim())}
                w={340}
              />
              <TextInput
                label={page === "inventory" ? "Location ID (optional)" : "Location ID"}
                value={locationId}
                onChange={(e) => setLocationId(e.currentTarget.value.trim())}
                w={340}
              />
              <TextInput
                label="Clerk"
                placeholder="who is making changes"
                value={actor}
                onChange={(e) => setActor(e.currentTarget.value)}
                w={200}
              />
            </Group>
            {page === "inventory" && (
              <InventoryPage
                key={`${tenantId}|${locationId}`}
                tenantId={tenantId}
                locationId={locationId}
              />
            )}
            {page === "receive" && <ReceivePage {...store} />}
            {page === "import" && <ImportPage {...store} />}
          </Stack>
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}
