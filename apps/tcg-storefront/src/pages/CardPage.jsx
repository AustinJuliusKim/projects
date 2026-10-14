import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Alert,
  Anchor,
  AspectRatio,
  Badge,
  Button,
  Chip,
  Grid,
  Group,
  Image,
  NumberInput,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";

import { getCard, isAbortError } from "../api.js";
import {
  cardDescription,
  cardImage,
  cartItem,
  offerRows,
  printingSummaries,
} from "../card.js";
import { canAdd, findLine, LINE_QTY_MAX } from "../cart.js";
import { CONDITION_LABELS, FINISH_LABELS } from "../facets.js";
import { displayCents, formatCents } from "../money.js";
import { pageTitle } from "../seo.js";
import { useStore } from "../storeContext.js";
import { useSeo } from "../useSeo.js";

const LANG_NAMES = { en: "English", ja: "Japanese", de: "German", fr: "French", it: "Italian",
  es: "Spanish", pt: "Portuguese", ru: "Russian", ko: "Korean", zhs: "Chinese (S)",
  zht: "Chinese (T)" };

export default function CardPage() {
  const { oracleId } = useParams();
  const { slug, base, store } = useStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [printingId, setPrintingId] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    setPrintingId(null);
    getCard(slug, oracleId, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (!isAbortError(e)) setError(e);
      });
    return () => controller.abort();
  }, [slug, oracleId]);

  const card = data && data.card;
  const offers = data ? data.offers : null;
  const allRows = useMemo(() => offerRows(card, offers), [card, offers]);
  const rows = useMemo(
    () => (printingId ? allRows.filter((r) => r.printing_id === printingId) : allRows),
    [allRows, printingId],
  );
  const printings = useMemo(() => printingSummaries(card, offers), [card, offers]);
  const selected = printings.find((p) => p.id === printingId) || null;
  const fromCents = allRows.length ? allRows[0].price_cents : null;

  useSeo({
    title: pageTitle([card ? card.name : error ? "Card not found" : "Card"], store.display_name),
    description: card
      ? cardDescription(card, { storeName: store.display_name, fromCents, formatCents })
      : undefined,
    noindex: Boolean(error),
  });

  if (error) {
    return (
      <Alert color={error.status === 404 ? "gray" : "red"} title="Card unavailable">
        {error.status === 404 ? "We couldn’t find that card." : error.message}{" "}
        <Anchor component={Link} to={base}>
          Back to the store
        </Anchor>
      </Alert>
    );
  }
  if (!card) return <CardSkeleton />;

  const img = cardImage(card, selected);
  return (
    <Grid gutter="xl">
      <Grid.Col span={{ base: 12, sm: 5, md: 4 }}>
        <AspectRatio ratio={488 / 680} maw={420} mx="auto">
          {img ? (
            <Image src={img} alt={card.name} radius="md" />
          ) : (
            <Skeleton radius="md" animate={false} />
          )}
        </AspectRatio>
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 7, md: 8 }}>
        <Stack gap="md">
          <Stack gap={4}>
            <Group gap="sm" align="baseline">
              <Title order={1} size="h2">
                {card.name}
              </Title>
              {card.mana_cost && (
                <Text c="dimmed" ff="monospace">
                  {card.mana_cost}
                </Text>
              )}
            </Group>
            {card.type_line && <Text fw={500}>{card.type_line}</Text>}
            {card.oracle_text && (
              <Text style={{ whiteSpace: "pre-line" }}>{card.oracle_text}</Text>
            )}
            {(card.power || card.toughness) && (
              <Text fw={600}>
                {card.power}/{card.toughness}
              </Text>
            )}
            {card.loyalty && <Text fw={600}>Loyalty {card.loyalty}</Text>}
          </Stack>

          {printings.length > 1 && (
            <Stack gap={6}>
              <Text fw={600} size="sm">
                Printings
              </Text>
              <Chip.Group value={printingId || "all"} onChange={(v) => setPrintingId(v === "all" ? null : v)}>
                <Group gap={6}>
                  <Chip value="all" size="xs">
                    All
                  </Chip>
                  {printings.map((p) => (
                    <Chip key={p.id} value={p.id} size="xs" disabled={p.offerCount === 0}>
                      {(p.set_code || "").toUpperCase()} {p.collector_number ? `#${p.collector_number}` : ""}
                      {p.offerCount ? ` · ${displayCents(p.fromCents)}` : ""}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
            </Stack>
          )}

          <Title order={2} size="h4">
            {allRows.length ? "In stock" : "Not in stock"}
          </Title>
          {allRows.length === 0 ? (
            <Text c="dimmed">
              {store.display_name} doesn’t have this card available online right now.
            </Text>
          ) : (
            <OfferTable rows={rows} card={card} />
          )}
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

function OfferTable({ rows, card }) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="xs" striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Printing</Table.Th>
            <Table.Th>Finish</Table.Th>
            <Table.Th>Condition</Table.Th>
            <Table.Th>Language</Table.Th>
            <Table.Th ta="right">Price</Table.Th>
            <Table.Th ta="right">Available</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <OfferRow key={row.inventory_item_id} row={row} card={card} />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function OfferRow({ row, card }) {
  const { cart, dispatch, base } = useStore();
  const [qty, setQty] = useState(1);
  const inCart = findLine(cart, row.inventory_item_id);
  const have = inCart ? inCart.qty : 0;
  const room = Math.max(0, Math.min(row.available, LINE_QTY_MAX) - have);
  const item = cartItem(card, row);
  const n = Math.min(Number(qty) || 1, Math.max(room, 1));
  const ok = room > 0 && canAdd(cart, item, n);

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm">{row.set_name || (row.set_code || "").toUpperCase()}</Text>
        <Text size="xs" c="dimmed">
          {(row.set_code || "").toUpperCase()}
          {row.collector_number ? ` #${row.collector_number}` : ""}
        </Text>
      </Table.Td>
      <Table.Td>
        {row.finish === "nonfoil" ? (
          <Text size="sm">{FINISH_LABELS.nonfoil}</Text>
        ) : (
          <Badge variant="light" color="grape" size="sm">
            {FINISH_LABELS[row.finish] || row.finish}
          </Badge>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm" title={CONDITION_LABELS[row.condition] || row.condition}>
          {row.condition}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{LANG_NAMES[row.lang] || row.lang}</Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm" fw={600}>
          {displayCents(row.price_cents)}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm">{row.available}</Text>
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap" justify="flex-end">
          {room > 1 && (
            <NumberInput
              size="xs"
              w={64}
              min={1}
              max={room}
              clampBehavior="strict"
              allowDecimal={false}
              allowNegative={false}
              value={qty}
              onChange={setQty}
              aria-label="Quantity"
            />
          )}
          <Button
            size="xs"
            disabled={!ok}
            onClick={() => {
              dispatch({ type: "add", item, qty: n });
              setQty(1);
            }}
          >
            {room === 0 ? "All in cart" : "Add"}
          </Button>
        </Group>
        {have > 0 && (
          <Anchor component={Link} to={`${base}/cart`} size="xs" display="block" ta="right">
            {have} in cart
          </Anchor>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function CardSkeleton() {
  return (
    <Grid gutter="xl">
      <Grid.Col span={{ base: 12, sm: 5, md: 4 }}>
        <AspectRatio ratio={488 / 680} maw={420} mx="auto">
          <Skeleton radius="md" />
        </AspectRatio>
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 7, md: 8 }}>
        <Stack>
          <Skeleton height={32} width="60%" />
          <Skeleton height={16} width="40%" />
          <Skeleton height={80} />
          <Skeleton height={160} />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
