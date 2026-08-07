import { MantineProvider, AppShell, Container, Group, Text, Anchor } from "@mantine/core";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";

import { theme } from "./theme.js";
import { useLog } from "./useLog.js";
import BrowseView from "./views/BrowseView.jsx";
import FoodView from "./views/FoodView.jsx";
import ProgressView from "./views/ProgressView.jsx";
import AllergensView from "./views/AllergensView.jsx";
import SafetyView from "./views/SafetyView.jsx";

const TABS = [
  ["/browse", "Foods"],
  ["/progress", "Progress"],
  ["/allergens", "Allergens"],
  ["/safety", "Safety"],
];

function App() {
  const log = useLog();

  return (
    <AppShell padding="md">
      <AppShell.Main>
        <Container size="sm" px="xs">
          <Routes>
            <Route path="/" element={<Navigate to="/browse" replace />} />
            <Route path="/browse" element={<BrowseView log={log} />} />
            <Route path="/food/:id" element={<FoodView log={log} />} />
            <Route path="/progress" element={<ProgressView log={log} />} />
            <Route path="/allergens" element={<AllergensView log={log} />} />
            <Route path="/safety" element={<SafetyView />} />
            <Route path="*" element={<Navigate to="/browse" replace />} />
          </Routes>

          <Text c="dimmed" size="xs" mt="xl" ta="center" className="bs-no-print">
            Not medical advice. Every claim links to its source — check them, and talk to your
            pediatrician about your own baby.
          </Text>
        </Container>
      </AppShell.Main>

      <nav className="bs-bottom-nav bs-no-print">
        <Group justify="space-around" py="sm" gap={0}>
          {TABS.map(([to, label]) => (
            <NavLink key={to} to={to} style={{ textDecoration: "none" }}>
              {({ isActive }) => (
                <Text size="sm" fw={isActive ? 700 : 400} c={isActive ? "violet.4" : "dimmed"}>
                  {label}
                </Text>
              )}
            </NavLink>
          ))}
        </Group>
      </nav>
    </AppShell>
  );
}

export default function Root() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <App />
    </MantineProvider>
  );
}
