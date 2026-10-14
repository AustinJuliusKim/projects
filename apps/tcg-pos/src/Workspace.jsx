import { useState } from "react";
import { AppShell, Burger, Group, NavLink, Stack, Text, TextInput } from "@mantine/core";

import CreditPage from "./CreditPage.jsx";
import ImportPage from "./ImportPage.jsx";
import InventoryPage from "./InventoryPage.jsx";
import PinPage from "./PinPage.jsx";
import ReceivePage from "./ReceivePage.jsx";
import RegistersPage from "./RegistersPage.jsx";
import TeamPage from "./TeamPage.jsx";
import { settlePage } from "./perms.js";

// The location the stock pages work at: typed in the back office (there's
// no locations endpoint yet), fixed to the register's in register mode.
function LocationBar({ ctx, optional }) {
  if (ctx.locationFixed) {
    return (
      <Text size="sm" c="dimmed">
        Location <Text span ff="monospace">{ctx.locationId || "—"}</Text> (this register&apos;s)
      </Text>
    );
  }
  return (
    <TextInput
      label={optional ? "Location ID (optional)" : "Location ID"}
      value={ctx.locationId}
      onChange={(e) => ctx.setLocationId(e.currentTarget.value.trim())}
      w={340}
    />
  );
}

// value → render(ctx). ctx: { tenantId, locationId, setLocationId,
// locationFixed, perms, roleKey, surface, store, me, device, dispatch }.
export const PAGES = {
  inventory: (ctx) => (
    <Stack>
      <LocationBar ctx={ctx} optional />
      <InventoryPage
        key={`${ctx.tenantId}|${ctx.locationId}`}
        tenantId={ctx.tenantId}
        locationId={ctx.locationId}
      />
    </Stack>
  ),
  receive: (ctx) => (
    <Stack>
      <LocationBar ctx={ctx} />
      <ReceivePage tenantId={ctx.tenantId} locationId={ctx.locationId} />
    </Stack>
  ),
  import: (ctx) => (
    <Stack>
      <LocationBar ctx={ctx} />
      <ImportPage tenantId={ctx.tenantId} locationId={ctx.locationId} />
    </Stack>
  ),
  credit: (ctx) => <CreditPage ctx={ctx} />,
  team: (ctx) => <TeamPage ctx={ctx} />,
  registers: (ctx) => <RegistersPage ctx={ctx} />,
  pin: (ctx) => <PinPage ctx={ctx} />,
};

// The signed-in layout shared by the back office and register mode: a
// header (store switcher or register bar), the nav the user's perms allow,
// and the page.
export default function Workspace({ header, nav, ctx, banner = null }) {
  const [page, setPage] = useState(null);
  const [opened, setOpened] = useState(false);
  const items = nav.filter((n) => PAGES[n.value]);
  const current = settlePage(page, items);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 180, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header px="md" style={{ display: "flex", alignItems: "center" }}>
        <Group w="100%" wrap="nowrap">
          <Burger opened={opened} onClick={() => setOpened((o) => !o)} hiddenFrom="sm" size="sm" />
          {header}
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {items.map((n) => (
          <NavLink
            key={n.value}
            label={n.label}
            active={n.value === current}
            onClick={() => {
              setPage(n.value);
              setOpened(false);
            }}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        {banner}
        {current ? PAGES[current](ctx) : <Text c="dimmed">Your role has no pages here.</Text>}
      </AppShell.Main>
    </AppShell>
  );
}
