import { useEffect, useMemo, useReducer, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";

import { getStore } from "../api.js";
import { cartCount, cartReducer, cartStorageKey, loadCart, saveCart } from "../cart.js";
import { StoreContext } from "../storeContext.js";
import { useSeo } from "../useSeo.js";
import SearchBox from "./SearchBox.jsx";

export default function StoreLayout({ slug }) {
  const base = `/s/${encodeURIComponent(slug)}`;
  const [store, setStore] = useState(null);
  const [storeError, setStoreError] = useState(null);
  const [cart, dispatch] = useReducer(cartReducer, slug, (s) => loadCart(s));

  useEffect(() => {
    const controller = new AbortController();
    getStore(slug, { signal: controller.signal })
      .then(setStore)
      .catch((e) => {
        if (!controller.signal.aborted) setStoreError(e);
      });
    return () => controller.abort();
  }, [slug]);

  useEffect(() => saveCart(slug, cart), [slug, cart]);

  // Keep tabs in step: another tab's cart change replaces ours.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === cartStorageKey(slug)) dispatch({ type: "replace", cart: loadCart(slug) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [slug]);

  const ctx = useMemo(() => ({ slug, base, store, cart, dispatch }), [slug, base, store, cart]);
  const count = cartCount(cart);

  if (storeError) return <StoreUnavailable error={storeError} />;

  return (
    <StoreContext.Provider value={ctx}>
      <Box
        component="header"
        py="sm"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: "var(--mantine-color-body)",
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Container size="xl">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Anchor component={Link} to={base} underline="never" c="inherit">
              <Title order={3} style={{ whiteSpace: "nowrap" }}>
                {store ? store.display_name : slug}
              </Title>
            </Anchor>
            <Box style={{ flex: "1 1 280px", maxWidth: 640, order: 0 }}>
              <SearchBox />
            </Box>
            <Button
              component={Link}
              to={`${base}/cart`}
              variant={count ? "filled" : "default"}
              rightSection={count ? <Badge variant="white" size="sm">{count}</Badge> : null}
              aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}
            >
              Cart
            </Button>
          </Group>
        </Container>
      </Box>
      <Container size="xl" py="md" component="main">
        {store ? <Outlet /> : <Loader m="xl" />}
      </Container>
      {store && (
        <Container size="xl" component="footer" py="lg">
          <Text size="sm" c="dimmed">
            Reserve online, pay and pick up in store at {store.pickup_location.name}.
          </Text>
        </Container>
      )}
    </StoreContext.Provider>
  );
}

function StoreUnavailable({ error }) {
  const missing = error.status === 404;
  useSeo({ title: missing ? "Store not found" : "Store unavailable", noindex: true });
  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title order={2}>{missing ? "Store not found" : "Store unavailable"}</Title>
        <Alert color={missing ? "gray" : "red"}>
          {missing
            ? "There is no published store at this address."
            : `The store couldn't be loaded: ${error.message}`}
        </Alert>
      </Stack>
    </Container>
  );
}
