import { Link, NavLink, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { AppShell, Group, TextInput, Title, Anchor, Text, MantineProvider } from "@mantine/core";

import CardPage from "./pages/CardPage.jsx";
import DeckPage from "./pages/DeckPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import { theme } from "./theme.js";

export default function Root() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <App />
    </MantineProvider>
  );
}

// Search text lives here (topbar, accessible from any page) so it's a
// single source of truth with SearchPage's other filters — both read/write
// the same `q` URL param via useSearchParams, no prop-drilling needed.
// Debounced ~300ms: the input echoes every keystroke instantly (local
// state), but the URL — and therefore SearchPage's fetch — only updates
// once typing pauses, so a fast typist doesn't fire a request per letter.
function App() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlQ = params.get("q") || "";

  const [qInput, setQInput] = useState(urlQ);
  const [debouncedQ] = useDebouncedValue(qInput, 300);

  // Keep the input in sync when the URL changes from elsewhere (back/
  // forward nav, a direct link with ?q=..., clearing filters).
  useEffect(() => {
    setQInput(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  // Push the debounced value to the URL, merging with (not replacing) any
  // other filters already set, and reset to page 1 like every other
  // filter change does. A single leftover character (e.g. mid-backspace)
  // is skipped rather than fired: /v1/cards/search enforces min_length=2
  // once a query is present, matching /autocomplete's existing floor —
  // this avoids a pointless 422 round-trip while someone's mid-edit.
  useEffect(() => {
    if (debouncedQ === urlQ) return;
    if (debouncedQ.length === 1) return;
    const next = new URLSearchParams(params);
    if (debouncedQ) next.set("q", debouncedQ);
    else next.delete("q");
    next.set("page", "1");
    navigate({ pathname: "/", search: next.toString() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  return (
    <AppShell header={{ height: 64 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Title order={3} component={Link} to="/" style={{ textDecoration: "none" }}>
              MTG DB
            </Title>
            <TextInput
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search cards…"
              aria-label="Search cards"
              w={280}
            />
          </Group>
          <Anchor component={NavLink} to="/deck">
            Deck
          </Anchor>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/card/:oracleId" element={<CardPage />} />
          <Route path="/deck" element={<DeckPage />} />
        </Routes>
        <Text size="xs" c="dimmed" mt="xl">
          Card data © Wizards of the Coast, provided by{" "}
          <Anchor href="https://scryfall.com">Scryfall</Anchor>. Unofficial Fan Content permitted
          under the Wizards of the Coast Fan Content Policy; not endorsed by Scryfall or Wizards
          of the Coast.
        </Text>
      </AppShell.Main>
    </AppShell>
  );
}
