import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Anchor,
  Button,
  CloseButton,
  Group,
  NumberInput,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

import { isAbortError, quoteCart } from "../api.js";
import {
  cartFingerprint,
  cartSubtotal,
  LINE_QTY_MAX,
  mergeQuote,
  quoteBody,
} from "../cart.js";
import LineInfo from "../components/LineInfo.jsx";
import { displayCents } from "../money.js";
import { pageTitle } from "../seo.js";
import { useStore } from "../storeContext.js";
import { useSeo } from "../useSeo.js";

const REQUOTE_DELAY_MS = 250;

// Re-price the cart against live stock whenever its contents change (and
// on load), dropping stale responses.
export function useQuote(slug, cart) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const fingerprint = cartFingerprint(cart);
  useEffect(() => {
    if (!cart.lines.length) {
      setQuote(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(null);
      quoteCart(slug, quoteBody(cart), { signal: controller.signal })
        .then((q) => {
          if (!controller.signal.aborted) setQuote(q);
        })
        .catch((e) => {
          if (!isAbortError(e)) setError(e.message);
        });
    }, REQUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The fingerprint is the cart's content; `cart` itself changes identity
    // on no-op updates.
  }, [slug, fingerprint]);
  return { quote, error };
}

export default function CartPage() {
  const { slug, base, store, cart, dispatch } = useStore();
  const { quote, error } = useQuote(slug, cart);
  const view = useMemo(() => mergeQuote(cart, quote), [cart, quote]);
  useSeo({ title: pageTitle(["Cart"], store.display_name), noindex: true });

  if (!cart.lines.length) {
    return (
      <Stack>
        <Title order={2}>Your cart is empty</Title>
        <Text>
          <Anchor component={Link} to={base}>
            Find something to add
          </Anchor>
          .
        </Text>
      </Stack>
    );
  }

  const total = view.totalCents ?? cartSubtotal(cart);
  const checking = !error && view.rows.some((r) => r.status === "pending");

  return (
    <Stack gap="lg">
      <Title order={2}>Cart</Title>
      {error && <Alert color="red">Couldn’t check prices and stock: {error}</Alert>}
      {view.issues.length > 0 && (
        <Alert color="yellow" title="Some items changed since you added them">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              Prices and stock are checked live. Review the flagged lines, or update the cart to
              take the current prices and quantities.
            </Text>
            <Button size="xs" onClick={() => dispatch({ type: "applyQuote", quote })}>
              Update cart
            </Button>
          </Stack>
        </Alert>
      )}
      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th ta="right">Price</Table.Th>
              <Table.Th>Qty</Table.Th>
              <Table.Th ta="right">Total</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {view.rows.map(({ line, status, issue, livePriceCents }) => (
              <Table.Tr key={line.inventory_item_id}>
                <Table.Td>
                  <LineInfo line={line} base={base} />
                  {issue && (
                    <Text size="xs" c={status === "price_changed" ? "orange" : "red"} mt={4}>
                      {issue}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td ta="right">
                  {status === "price_changed" ? (
                    <Stack gap={0} align="flex-end">
                      <Text size="sm" td="line-through" c="dimmed">
                        {displayCents(line.unit_price_cents)}
                      </Text>
                      <Text size="sm" fw={600}>
                        {displayCents(livePriceCents)}
                      </Text>
                    </Stack>
                  ) : (
                    <Text size="sm">{displayCents(line.unit_price_cents)}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size="xs"
                    w={70}
                    min={1}
                    max={LINE_QTY_MAX}
                    clampBehavior="strict"
                    allowDecimal={false}
                    allowNegative={false}
                    value={line.qty}
                    onChange={(v) => {
                      if (Number(v) >= 1) {
                        dispatch({ type: "setQty", id: line.inventory_item_id, qty: Number(v) });
                      }
                    }}
                    aria-label={`Quantity of ${line.name || "item"}`}
                  />
                </Table.Td>
                <Table.Td ta="right">
                  <Text size="sm">
                    {Number.isInteger(livePriceCents) ? displayCents(livePriceCents * line.qty) : "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <CloseButton
                    aria-label={`Remove ${line.name || "item"}`}
                    onClick={() => dispatch({ type: "remove", id: line.inventory_item_id })}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Paper withBorder p="md" radius="md" maw={420} ml="auto" w="100%">
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600}>Total</Text>
            <Text fw={700} size="lg">
              {displayCents(total)}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            Nothing is charged online. You pay when you pick up at {store.pickup_location.name}.
          </Text>
          <Button
            component={Link}
            to={`${base}/checkout`}
            disabled={!view.ok}
            onClick={(e) => {
              if (!view.ok) e.preventDefault();
            }}
            fullWidth
          >
            {checking ? "Checking stock…" : "Reserve for pickup"}
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
