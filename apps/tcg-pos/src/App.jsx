import { AppShell, MantineProvider, Title } from "@mantine/core";

import InventoryPage from "./InventoryPage.jsx";

export default function App() {
  return (
    <MantineProvider defaultColorScheme="auto">
      <AppShell header={{ height: 56 }} padding="md">
        <AppShell.Header px="md" style={{ display: "flex", alignItems: "center" }}>
          <Title order={3}>TCG POS</Title>
        </AppShell.Header>
        <AppShell.Main>
          <InventoryPage />
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}
