import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Anchor, Group, Paper, Stack, Text, Title } from "@mantine/core";

import { isAbortError, searchStore } from "../api.js";
import CardGrid, { CardGridSkeleton } from "../components/CardGrid.jsx";
import SearchBox from "../components/SearchBox.jsx";
import { emptyState, searchHref, toRequestParams } from "../searchState.js";
import { useStore } from "../storeContext.js";
import { pageTitle } from "../seo.js";
import { useSeo } from "../useSeo.js";

const SHELF_SIZE = 12;

// A row of in-stock cards in one sort order, with a link to see them all.
function Shelf({ title, sort }) {
  const { slug, base } = useStore();
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const state = useMemo(
    () => ({ ...emptyState(), mode: "stock", sort, pageSize: SHELF_SIZE }),
    [sort],
  );

  useEffect(() => {
    const controller = new AbortController();
    searchStore(slug, toRequestParams(state), { signal: controller.signal })
      .then(setResult)
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      });
    return () => controller.abort();
  }, [slug, state]);

  if (result && result.results.length === 0) return null;
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="baseline">
        <Title order={3}>{title}</Title>
        <Anchor component={Link} to={searchHref(slug, { ...state, pageSize: 24 })} size="sm">
          See all
        </Anchor>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {!result && !error && <CardGridSkeleton count={6} />}
      {result && <CardGrid cards={result.results} base={base} mode="stock" />}
    </Stack>
  );
}

export default function HomePage() {
  const { store } = useStore();
  useSeo({
    title: pageTitle(["Singles in stock"], store.display_name),
    description: `Search ${store.display_name}'s in-stock singles and reserve them for pickup at ${store.pickup_location.name}.`,
  });
  return (
    <Stack gap="xl">
      <Paper withBorder p={{ base: "md", sm: "xl" }} radius="md">
        <Stack gap="sm">
          <Title order={1} size="h2">
            {store.display_name}
          </Title>
          <Text c="dimmed">
            Find a card, reserve it online, and pick it up at {store.pickup_location.name}.
            {store.reservation_hours ? ` Reservations are held for ${store.reservation_hours} hours.` : ""}
          </Text>
          <SearchBox size="lg" />
        </Stack>
      </Paper>
      <Shelf title="Popular in stock" sort="popular" />
      <Shelf title="New arrivals" sort="newest" />
    </Stack>
  );
}
