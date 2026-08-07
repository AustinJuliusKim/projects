import { useParams, Link } from "react-router-dom";
import { Stack, Title, Text, Badge, Group, Card, Button, Alert, Anchor, Divider } from "@mantine/core";

import { FOODS_BY_ID } from "../useLog.js";
import { ACCEPTANCE_EXPOSURES } from "../store/projections.js";

import { tierBadge } from "../tiers.js";

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
        <AllergenBadge food={food} />
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

      {food.frequencyLimit && (
        <Alert color="yellow" title="Good, but not too often" variant="light">
          <Text size="sm">
            At most {food.frequencyLimit.maxPerWeek}× a week. {food.frequencyLimit.reason}
          </Text>
        </Alert>
      )}

      {food.backgroundMd && <Prose text={food.backgroundMd} />}

      <Divider label="How to serve it" labelPosition="left" />
      <Text size="xs" c="dimmed">
        The one size rule any guideline body actually issues is AAP's: no piece larger than half an
        inch. The specific shapes below, and the age bands themselves, are common practice built
        from grasp milestones — sensible, widely used, and not handed down by anyone. Treat them as
        a starting point for your baby, not a standard.
      </Text>
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
      <Text size="xs" c="dimmed">
        Dates are when the source was consulted. One caveat worth knowing: cdc.gov blocks
        automated retrieval, so CDC text in this canon was read from archive captures rather than
        the live page. The wording was checked; the live page may have moved on.
      </Text>
      <Stack gap={6}>
        {food.sources.map((src) => {
          const [label, color] = tierBadge(src.tier);
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

/** The nine allergens US labels must declare. */
const US_NINE = new Set([
  "milk",
  "egg",
  "fish",
  "crustacean_shellfish",
  "tree_nut",
  "peanut",
  "wheat",
  "soy",
  "sesame",
]);

/**
 * The allergen chip, which has to carry three states rather than two.
 *
 * The missing one is the dangerous one. Molluscs — oyster, mussel, clam,
 * scallop — are genuinely allergenic and can be severe, but they are NOT among
 * the nine allergens US labels must declare; crustacean is. So a plain orange
 * "mollusc" chip implies a packet will warn you, and a grey "not a major
 * allergen" chip implies there is nothing to react to. Both mislead, in
 * opposite directions, about a food sold on the same counter as shrimp.
 *
 * The third state says the true thing: real allergen, no US labelling duty,
 * read the ingredients.
 */
function AllergenBadge({ food }) {
  const listed = food.allergens.filter((a) => US_NINE.has(a));
  const unlisted = food.allergens.filter((a) => !US_NINE.has(a));

  if (listed.length) {
    return (
      <Badge variant="light" color="orange">
        {listed.join(", ")}
      </Badge>
    );
  }
  if (unlisted.length) {
    return (
      <Badge variant="light" color="yellow">
        {unlisted.join(", ")} — not US-labelled
      </Badge>
    );
  }
  return (
    <Badge variant="light" color="gray">
      not a major allergen
    </Badge>
  );
}

/**
 * Renders authored prose: paragraphs, bullet lists, and **bold**.
 *
 * Deliberately not a Markdown library. The content is ours and uses a small,
 * known subset, so a 30-line renderer beats a dependency that would also
 * happily render images and links from a data file. But it does need to handle
 * bold: records lean on it for the phrase that matters in a safety paragraph,
 * and rendering `**never raw**` as literal asterisks is worse than not bolding
 * at all — it reads as a typo in exactly the sentence a parent should trust.
 */
function Prose({ text, size = "md" }) {
  const blocks = text.split(/\n{2,}/).filter(Boolean);
  return (
    <Stack gap="xs">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <Stack key={i} gap={4} pl="sm">
              {lines.map((l, j) => (
                <Text key={j} size={size}>
                  • {inline(l.replace(/^\s*[-*]\s+/, ""))}
                </Text>
              ))}
            </Stack>
          );
        }
        return (
          <Text key={i} size={size}>
            {inline(block.replace(/\n/g, " "))}
          </Text>
        );
      })}
    </Stack>
  );
}

/** Splits on **bold** spans, leaving everything else as text. */
function inline(s) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      part
    ),
  );
}
