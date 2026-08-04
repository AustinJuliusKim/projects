import { Link } from "react-router-dom";
import { SimpleGrid, Card, Image, Text, Group, ActionIcon, Stack } from "@mantine/core";

export default function CardGrid({ cards, onAdd }) {
  if (!cards.length) return <Text c="dimmed">No cards.</Text>;
  return (
    <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5 }} spacing="md" mt="md">
      {cards.map((card) => (
        <Card key={card.oracle_id} withBorder padding="sm" radius="md">
          <Card.Section>
            <Link to={`/card/${card.oracle_id}`}>
              {card.image_normal || card.image_small ? (
                <Image src={card.image_normal || card.image_small} alt={card.name} loading="lazy" />
              ) : (
                <Stack p="md" gap={4} mih={200} justify="center">
                  <Text fw={700}>{card.name}</Text>
                  <Text size="sm" c="dimmed">
                    {card.type_line}
                  </Text>
                </Stack>
              )}
            </Link>
          </Card.Section>
          <Group justify="space-between" wrap="nowrap" mt="xs" gap="xs">
            <Text component={Link} to={`/card/${card.oracle_id}`} size="sm" fw={600} lineClamp={1}>
              {card.name}
            </Text>
            {onAdd && (
              <ActionIcon onClick={() => onAdd(card)} variant="light" title="Add to deck" size="sm">
                +
              </ActionIcon>
            )}
          </Group>
        </Card>
      ))}
    </SimpleGrid>
  );
}
