// Adapted from mtg-webapp's CardGrid (to be extracted to a shared package
// once the branches merge). Images are Scryfall URLs from the API,
// hotlinked as given — never rehosted.
import { Link } from "react-router-dom";
import { AspectRatio, Badge, Card, Group, Image, SimpleGrid, Skeleton, Stack, Text } from "@mantine/core";

import { displayCents } from "../money.js";

const COLS = { base: 2, xs: 3, sm: 4, lg: 6 };
const RATIO = 488 / 680; // Scryfall card image aspect

function StockLine({ card, mode }) {
  if (mode === "stock") {
    const n = Number.isInteger(card.in_stock) ? card.in_stock : null;
    return (
      <Group justify="space-between" gap={4} wrap="nowrap">
        <Text size="sm" fw={600}>
          {card.price_cents != null ? `from ${displayCents(card.price_cents)}` : "—"}
        </Text>
        {n !== null && (
          <Text size="xs" c="dimmed">
            {n} in stock
          </Text>
        )}
      </Group>
    );
  }
  return card.in_stock ? (
    <Badge size="sm" color="green" variant="light">
      In stock
    </Badge>
  ) : (
    <Text size="xs" c="dimmed">
      Not in stock
    </Text>
  );
}

export default function CardGrid({ cards, base, mode = "stock" }) {
  return (
    <SimpleGrid cols={COLS} spacing="md">
      {cards.map((card) => {
        const href = `${base}/card/${card.oracle_id}`;
        const img = card.image_normal || card.image_small;
        return (
          <Card key={card.oracle_id} withBorder padding="xs" radius="md">
            <Card.Section>
              <Link to={href} aria-label={card.name}>
                <AspectRatio ratio={RATIO}>
                  {img ? (
                    <Image src={img} alt={card.name} loading="lazy" decoding="async" />
                  ) : (
                    <Stack p="sm" gap={4} justify="center" bg="var(--mantine-color-default-hover)">
                      <Text fw={700}>{card.name}</Text>
                      <Text size="xs" c="dimmed">
                        {card.type_line}
                      </Text>
                    </Stack>
                  )}
                </AspectRatio>
              </Link>
            </Card.Section>
            <Stack gap={2} mt="xs">
              <Text component={Link} to={href} size="sm" fw={500} lineClamp={1} title={card.name}>
                {card.name}
              </Text>
              <StockLine card={card} mode={mode} />
            </Stack>
          </Card>
        );
      })}
    </SimpleGrid>
  );
}

export function CardGridSkeleton({ count = 12 }) {
  return (
    <SimpleGrid cols={COLS} spacing="md">
      {Array.from({ length: count }, (_, i) => (
        <Stack key={i} gap="xs">
          <AspectRatio ratio={RATIO}>
            <Skeleton radius="md" />
          </AspectRatio>
          <Skeleton height={12} width="70%" />
        </Stack>
      ))}
    </SimpleGrid>
  );
}
