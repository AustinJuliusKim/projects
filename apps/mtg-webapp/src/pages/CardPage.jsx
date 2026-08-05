import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Grid,
  Stack,
  Image,
  Button,
  Title,
  Text,
  Table,
  List,
  Paper,
  Group,
} from "@mantine/core";

import { getCard, getPrintings, getRulings, isAbortError } from "../api.js";
import { addCard, loadDeck, saveDeck } from "../deck.js";
import SimilarPanel from "../components/SimilarPanel.jsx";
import { CardPageSkeleton } from "../components/Skeletons.jsx";

export default function CardPage() {
  const { oracleId } = useParams();
  const [card, setCard] = useState(null);
  const [printings, setPrintings] = useState([]);
  const [rulings, setRulings] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    setCard(null);
    setError(null);
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    getCard(oracleId, opts)
      .then(setCard)
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      });
    getPrintings(oracleId, opts)
      .then(setPrintings)
      .catch(() => {});
    getRulings(oracleId, opts)
      .then(setRulings)
      .catch(() => {});
    return () => controller.abort();
  }, [oracleId]);

  if (error) return <Text c="dimmed">{error}</Text>;
  if (!card) return <CardPageSkeleton />;

  function onAdd(c) {
    saveDeck(addCard(loadDeck(), { ...card, ...c }));
  }

  return (
    <Grid gutter="xl">
      <Grid.Col span={{ base: 12, sm: 4, md: 3 }}>
        <Stack>
          {card.image_normal && <Image src={card.image_normal} alt={card.name} radius="md" />}
          <Button onClick={() => saveDeck(addCard(loadDeck(), card))} fullWidth>
            Add to deck
          </Button>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 8, md: 9 }}>
        <Stack gap="lg">
          <div>
            <Title order={1}>
              {card.name}{" "}
              <Text component="span" size="lg" c="dimmed" fw={400}>
                {card.mana_cost}
              </Text>
            </Title>
            <Text c="dimmed">{card.type_line}</Text>
            <Text mt="sm" style={{ whiteSpace: "pre-line" }}>
              {card.oracle_text}
            </Text>
            {(card.power || card.loyalty || card.defense) && (
              <Text mt="xs" fw={600}>
                {card.power != null ? `${card.power}/${card.toughness}` : null}
                {card.loyalty != null ? `Loyalty ${card.loyalty}` : null}
                {card.defense != null ? `Defense ${card.defense}` : null}
              </Text>
            )}
          </div>

          {/* The differentiator lives above the fold */}
          <div>
            <Title order={2} size="h3" mb="xs">
              Similar cards
            </Title>
            <SimilarPanel oracleId={oracleId} onAdd={onAdd} />
          </div>

          {printings.length > 0 && (
            <div>
              <Title order={2} size="h3" mb="xs">
                Printings
              </Title>
              <Paper withBorder radius="md" style={{ overflowX: "auto" }}>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Set</Table.Th>
                      <Table.Th>#</Table.Th>
                      <Table.Th>Rarity</Table.Th>
                      <Table.Th>USD</Table.Th>
                      <Table.Th>EUR</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {printings.map((p) => (
                      <Table.Tr key={p.id}>
                        <Table.Td>{p.set_name || p.set_code}</Table.Td>
                        <Table.Td>{p.collector_number}</Table.Td>
                        <Table.Td>{p.rarity}</Table.Td>
                        <Table.Td>{p.price_usd != null ? `$${p.price_usd}` : "—"}</Table.Td>
                        <Table.Td>{p.price_eur != null ? `€${p.price_eur}` : "—"}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Paper>
            </div>
          )}

          {rulings.length > 0 && (
            <div>
              <Title order={2} size="h3" mb="xs">
                Rulings
              </Title>
              <List spacing="xs" size="sm">
                {rulings.map((r, i) => (
                  <List.Item key={i}>
                    <Group gap={6} wrap="nowrap">
                      {r.published_at && (
                        <Text c="dimmed" size="sm">
                          {r.published_at} —
                        </Text>
                      )}
                      <Text size="sm">{r.comment}</Text>
                    </Group>
                  </List.Item>
                ))}
              </List>
            </div>
          )}
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
