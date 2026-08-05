import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Grid, Stack, Title, Text, Group, ActionIcon, Button, Paper } from "@mantine/core";

import { getSimilar } from "../api.js";
import { logAction } from "../feedback.js";
import ConfidenceBadge from "../components/ConfidenceBadge.jsx";
import { SimilarRowsSkeleton } from "../components/Skeletons.jsx";
import {
  addCard,
  cardCount,
  deckIdentity,
  groupByType,
  loadDeck,
  removeCard,
  saveDeck,
} from "../deck.js";

// Deck-level suggestions: union of /similar over the deck's cards, filtered
// to the deck's color identity, aggregated by best confidence.
async function deckSuggestions(deck) {
  const identity = deckIdentity(deck);
  const cards = Object.values(deck.cards).slice(0, 15);
  const inDeck = new Set(Object.keys(deck.cards));
  const best = new Map();
  const settled = await Promise.allSettled(
    cards.map((c) =>
      getSimilar(c.oracle_id, { limit: 10, identity: identity || null }).then((results) => ({
        seed: c.oracle_id,
        results,
      })),
    ),
  );
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const s of outcome.value.results) {
      if (inDeck.has(s.oracle_id)) continue;
      const prev = best.get(s.oracle_id);
      if (!prev || s.confidence > prev.confidence) {
        best.set(s.oracle_id, { ...s, seed: outcome.value.seed });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}

export default function DeckPage() {
  const [deck, setDeck] = useState(loadDeck);
  const [suggestions, setSuggestions] = useState(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupByType(deck), [deck]);
  const identity = deckIdentity(deck);

  function update(next) {
    setDeck(next);
    saveDeck(next);
  }

  async function suggest() {
    setBusy(true);
    try {
      setSuggestions(await deckSuggestions(deck));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid gutter="xl">
      <Grid.Col span={{ base: 12, md: 8 }}>
        <Stack gap="lg">
          <Title order={1}>
            {deck.name}{" "}
            <Text component="span" c="dimmed" fw={400} size="lg">
              ({cardCount(deck)} cards{identity ? `, ${identity}` : ""})
            </Text>
          </Title>
          {cardCount(deck) === 0 && (
            <Text c="dimmed">
              Empty deck — add cards from <Text component={Link} to="/">search</Text> or any card
              page.
            </Text>
          )}
          {groups.map(({ type, cards }) => (
            <div key={type}>
              <Title order={2} size="h4" mb="xs">
                {type}
              </Title>
              <Stack gap={4}>
                {cards.map((c) => (
                  <Group key={c.oracle_id} gap="xs" wrap="nowrap">
                    <Text c="dimmed" w={32}>
                      {c.qty}×
                    </Text>
                    <Text component={Link} to={`/card/${c.oracle_id}`} style={{ flex: 1 }}>
                      {c.name}
                    </Text>
                    <Group gap={4} wrap="nowrap">
                      <ActionIcon size="sm" variant="light" onClick={() => update(addCard(deck, c))}>
                        +
                      </ActionIcon>
                      <ActionIcon
                        size="sm"
                        variant="light"
                        onClick={() => update(removeCard(deck, c.oracle_id))}
                      >
                        −
                      </ActionIcon>
                    </Group>
                  </Group>
                ))}
              </Stack>
            </div>
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 4 }}>
        <Stack gap="sm">
          <Title order={2} size="h4">
            Suggestions
          </Title>
          <Button onClick={suggest} disabled={busy || cardCount(deck) === 0} loading={busy}>
            {busy ? "Thinking…" : "Suggest cards for this deck"}
          </Button>
          {busy && <SimilarRowsSkeleton count={6} />}
          {suggestions !== null && suggestions.length === 0 && (
            <Text c="dimmed" size="sm">
              No suggestions (are embeddings loaded yet?).
            </Text>
          )}
          {suggestions?.length > 0 && (
            <Stack gap="xs">
              {suggestions.map((s) => (
                <Paper key={s.oracle_id} withBorder p="xs" radius="sm">
                  <Group gap="xs" wrap="nowrap">
                    <Text
                      component={Link}
                      to={`/card/${s.oracle_id}`}
                      onClick={() => logAction("click", s.seed, s, "deck_builder")}
                      style={{ flex: 1 }}
                      size="sm"
                      fw={600}
                    >
                      {s.name}
                    </Text>
                    <ConfidenceBadge confidence={s.confidence} band={s.band} />
                    <ActionIcon
                      size="sm"
                      variant="light"
                      title="Add to deck"
                      onClick={() => {
                        logAction("deck_add", s.seed, s, "deck_builder");
                        update(addCard(deck, s));
                      }}
                    >
                      +
                    </ActionIcon>
                  </Group>
                  {s.reasons.length > 0 && (
                    <Text size="xs" c="dimmed" mt={4}>
                      {s.reasons.join(" · ")}
                    </Text>
                  )}
                </Paper>
              ))}
            </Stack>
          )}
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
