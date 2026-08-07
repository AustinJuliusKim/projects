import { Link } from "react-router-dom";
import { Stack, Title, Text, Progress, Card, Group, Badge, RingProgress, Anchor } from "@mantine/core";

import { FOODS, FOODS_BY_ID } from "../useLog.js";
import { ACCEPTANCE_EXPOSURES } from "../store/projections.js";

const GOAL = 100;

/** Categories worth spreading across, in the order they're shown. */
const CATEGORIES = [
  ["fruit", "Fruit"],
  ["vegetable", "Vegetable"],
  ["grain", "Grain"],
  ["starch", "Starch"],
  ["animal_protein", "Animal protein"],
  ["plant_protein", "Plant protein"],
  ["dairy", "Dairy"],
  ["fat", "Fat"],
  ["herb_spice", "Herbs & spices"],
];

export default function ProgressView({ log }) {
  const tried = Object.keys(log.status);
  const inProgress = tried
    .map((id) => ({ id, ...log.status[id] }))
    .filter((f) => f.count < ACCEPTANCE_EXPOSURES && f.everRefused)
    .sort((a, b) => b.count - a.count);

  return (
    <Stack gap="md" pt="md">
      <Title order={2}>100 foods before one</Title>

      <Group>
        <RingProgress
          size={110}
          thickness={10}
          roundCaps
          sections={[{ value: Math.min(100, (tried.length / GOAL) * 100), color: "violet" }]}
          label={
            <Text ta="center" fw={700} size="lg">
              {tried.length}
            </Text>
          }
        />
        <Stack gap={4} style={{ flex: 1 }}>
          <Text size="sm">
            <b>{tried.length}</b> of {GOAL} distinct foods
          </Text>
          <Text size="xs" c="dimmed">
            The count is the fun part, but the spread is the useful part —
            repeated-exposure benefits carry across foods within a category,
            not between categories.
          </Text>
        </Stack>
      </Group>

      <Card withBorder padding="sm">
        <Text fw={600} size="sm" mb="xs">
          Category coverage
        </Text>
        <Stack gap={8}>
          {CATEGORIES.map(([key, label]) => {
            const available = FOODS.filter((f) => f.category === key).length;
            const done = log.coverage[key] ?? 0;
            return (
              <div key={key}>
                <Group justify="space-between" mb={2}>
                  <Text size="xs">{label}</Text>
                  <Text size="xs" c="dimmed">
                    {done}
                    {available ? ` / ${available} in canon` : ""}
                  </Text>
                </Group>
                <Progress
                  value={available ? (done / available) * 100 : 0}
                  size="sm"
                  color={done === 0 ? "gray" : "violet"}
                />
              </div>
            );
          })}
        </Stack>
      </Card>

      {inProgress.length > 0 && (
        <Card withBorder padding="sm">
          <Text fw={600} size="sm" mb={4}>
            Keep offering
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            Refused once isn’t a verdict. In one study a disliked vegetable was
            eaten as readily as a liked one by about the eighth try.
          </Text>
          <Stack gap={6}>
            {inProgress.map((f) => (
              <Group key={f.id} justify="space-between">
                <Anchor component={Link} to={`/food/${f.id}`} size="sm">
                  {FOODS_BY_ID[f.id]?.name ?? f.id}
                </Anchor>
                <Badge size="sm" variant="light">
                  {f.count} of ~{ACCEPTANCE_EXPOSURES}
                </Badge>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {tried.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" py="lg">
          Nothing logged yet. Pick a food and tap “Tasted”.
        </Text>
      )}
    </Stack>
  );
}
