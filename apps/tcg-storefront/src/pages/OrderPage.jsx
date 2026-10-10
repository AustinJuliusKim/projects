import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

import { getOrder, isAbortError } from "../api.js";
import LineInfo from "../components/LineInfo.jsx";
import { displayCents } from "../money.js";
import { pageTitle } from "../seo.js";
import { useStore } from "../storeContext.js";
import { useSeo } from "../useSeo.js";

const STATUS = {
  reserved: { label: "Reserved", color: "green" },
  picked_up: { label: "Picked up", color: "blue" },
  cancelled: { label: "Cancelled", color: "gray" },
  expired: { label: "Expired", color: "gray" },
};

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function OrderPage() {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const code = params.get("code") || "";
  const { slug, base, store } = useStore();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  useSeo({ title: pageTitle(["Your reservation"], store.display_name), noindex: true });

  useEffect(() => {
    if (!code) {
      setError("This link is missing its pickup code.");
      return undefined;
    }
    const controller = new AbortController();
    getOrder(slug, orderId, code, { signal: controller.signal })
      .then(setOrder)
      .catch((e) => {
        if (isAbortError(e)) return;
        setError(e.status === 404 ? "We couldn’t find that reservation." : e.message);
      });
    return () => controller.abort();
  }, [slug, orderId, code]);

  if (error) {
    return (
      <Alert color="red" title="Reservation unavailable">
        {error}{" "}
        <Anchor component={Link} to={base}>
          Back to the store
        </Anchor>
      </Alert>
    );
  }
  if (!order) return <Loader m="xl" />;

  const status = STATUS[order.status] || { label: order.status, color: "gray" };
  const shop = order.store || store;
  return (
    <Stack gap="lg" maw={760}>
      <Group gap="sm">
        <Title order={2}>
          {order.status === "reserved" ? "You’re all set" : "Your reservation"}
        </Title>
        <Badge color={status.color} variant="light">
          {status.label}
        </Badge>
      </Group>
      <Paper withBorder p="lg" radius="md">
        <Stack gap="xs" align="center">
          <Text size="sm" c="dimmed">
            Pickup code
          </Text>
          <Text fz={40} fw={800} ff="monospace" lts={4}>
            {order.pickup_code}
          </Text>
          <Text size="sm" ta="center">
            Show this code at {shop.pickup_location.name}
            {order.status === "reserved" && order.expires_at
              ? ` before ${when(order.expires_at)}`
              : ""}
            . Pay when you pick up.
          </Text>
        </Stack>
      </Paper>
      {shop.pickup_text && <Text style={{ whiteSpace: "pre-line" }}>{shop.pickup_text}</Text>}
      <Text size="sm" c="dimmed">
        Reserved for {order.customer_name} on {when(order.created_at)}. Keep this page’s link to
        check your reservation later.
      </Text>
      <Table.ScrollContainer minWidth={480}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th ta="right">Qty</Table.Th>
              <Table.Th ta="right">Price</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {order.lines.map((line) => (
              <Table.Tr key={line.inventory_item_id}>
                <Table.Td>
                  <LineInfo line={line} />
                </Table.Td>
                <Table.Td ta="right">{line.qty}</Table.Td>
                <Table.Td ta="right">{displayCents(line.unit_price_cents)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Group justify="space-between">
        <Text fw={600}>Total due at pickup</Text>
        <Text fw={700} size="lg">
          {displayCents(order.total_cents)}
        </Text>
      </Group>
      {shop.policy_text && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-line" }}>
          {shop.policy_text}
        </Text>
      )}
      <Anchor component={Link} to={base}>
        Keep shopping
      </Anchor>
    </Stack>
  );
}
