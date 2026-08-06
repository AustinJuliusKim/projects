import { useParams, Link } from "react-router-dom";
import { Stack, Title, Text, Badge, Group, Card, Button, Alert, Anchor, Divider } from "@mantine/core";

import { FOODS_BY_ID } from "../useLog.js";
import { ACCEPTANCE_EXPOSURES } from "../store/projections.js";

const TIER_LABEL = {
  guideline: ["Guideline", "teal"],
  trial: ["Trial", "blue"],
  expert_opinion: ["Expert opinion", "grape"],
  common_practice: ["Common practice", "gray"],
};

export default function FoodView({ log }) {
  const { id } = useParams();
  const food = FOODS_BY_ID[id];
  if (!food) return <Text pt="md">Unknown food.</Text>;

  const s = log.status[food.id];

  return (
    <Stack gap="md" pt="md">
      <div>
        <Title order={2}>{food.name}</Title>
        <Text size="sm" c="dimmed">
          {food.aliases?.join(" · ")}
        </Text>
      </div>

      <Group gap="xs">
        <Badge variant="light">from {food.firstOkMonths} months</Badge>
        <Badge variant="light" color={food.choking.level === "low" ? "green" : "yellow"}>
          choking: {food.choking.level}
        </Badge>
        <Badge variant="light" color={food.allergens.length ? "orange" : "gray"}>
          {food.allergens.length ? food.allergens.join(", ") : "not a major allergen"}
        </Badge>
        <Badge variant="light">iron: {food.nutrients.ironType.replace("_", "-")}</Badge>
      </Group>

      {!food.reviewedOn && (
        <Alert color="gray" title="Draft — not yet checked by a human" variant="light">
          <Text size="sm">
            This record was written from the sources listed at the bottom, but nobody has read it
            back against them yet. Follow the links before you act on it.
          </Text>
        </Alert>
      )}

      {food.allergenProtocol && (
        <Alert color="orange" title="Before the first taste" variant="light">
          <Text size="sm">{food.allergenProtocol.medicalGate}</Text>
        </Alert>
      )}

      {food.choking.requiredModification && (
        <Alert color="yellow" title="Required preparation" variant="light">
          <Text size="sm">{food.choking.requiredModification}</Text>
        </Alert>
      )}

      {food.backgroundMd && <Prose text={food.backgroundMd} />}

      <Divider label="How to serve it" labelPosition="left" />
      {food.ageBands.map((band) => (
        <Card key={band.band} withBorder padding="sm">
          <Group justify="space-between" mb={4}>
            <Text fw={700} size="sm">
              {band.band} months
            </Text>
            <Badge size="xs" variant="outline">
              {band.geometry.replace(/-/g, " ")}
            </Badge>
          </Group>
          <Prose text={band.prepMd} size="sm" />
          {band.servingNote && (
            <Text size="xs" c="dimmed" mt={6} fs="italic">
              {band.servingNote}
            </Text>
          )}
        </Card>
      ))}

      {food.safetyNoteMd && (
        <>
          <Divider label="Safety" labelPosition="left" />
          <Prose text={food.safetyNoteMd} size="sm" />
        </>
      )}

      <Card withBorder padding="sm">
        {s ? (
          <Text size="sm">
            Tried <b>{s.count}×</b>
            {s.count < ACCEPTANCE_EXPOSURES && (
              <Text span c="dimmed">
                {" "}
                — most babies come around by about {ACCEPTANCE_EXPOSURES}. Keep offering.
              </Text>
            )}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            Not tried yet.
          </Text>
        )}
        <Group mt="sm" gap="xs">
          <Button size="xs" variant="default" onClick={() => log.logFoods([food.id], "none")}>
            Refused
          </Button>
          <Button size="xs" variant="light" onClick={() => log.logFoods([food.id], "tasted")}>
            Tasted
          </Button>
          <Button size="xs" onClick={() => log.logFoods([food.id], "some")}>
            Ate it
          </Button>
        </Group>
      </Card>

      {food.relatedIds?.length > 0 && (
        <Text size="sm">
          See also:{" "}
          {food.relatedIds.map((rid, i) => (
            <span key={rid}>
              {i > 0 && ", "}
              <Anchor component={Link} to={`/food/${rid}`}>
                {FOODS_BY_ID[rid]?.name ?? rid}
              </Anchor>
            </span>
          ))}
        </Text>
      )}

      <Divider label="Sources" labelPosition="left" />
      <Stack gap={6}>
        {food.sources.map((src) => {
          const [label, color] = TIER_LABEL[src.tier] ?? ["Source", "gray"];
          return (
            <Group key={src.url} gap="xs" wrap="nowrap" align="flex-start">
              <Badge size="xs" color={color} variant="light" style={{ flexShrink: 0 }}>
                {label}
              </Badge>
              <Text size="xs">
                <Anchor href={src.url} target="_blank" rel="noreferrer">
                  {src.body}
                </Anchor>{" "}
                <Text span c="dimmed">
                  · checked {src.retrieved}
                </Text>
              </Text>
            </Group>
          );
        })}
      </Stack>
    </Stack>
  );
}

/** Markdown is authored as plain paragraphs; render them as such. */
function Prose({ text, size = "md" }) {
  return (
    <Stack gap="xs">
      {text
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((para, i) => (
          <Text key={i} size={size}>
            {para.replace(/\n/g, " ")}
          </Text>
        ))}
    </Stack>
  );
}
