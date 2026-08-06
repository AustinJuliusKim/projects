import { Stack, Title, Text, Card, Group, Badge, Table, Anchor, Alert } from "@mantine/core";

/**
 * Reachable in one tap from anywhere, because the moment you need it is not
 * the moment to go looking for it.
 */
export default function SafetyView() {
  return (
    <Stack gap="md" pt="md">
      <Title order={2}>Gagging vs choking</Title>

      <Alert color="violet" variant="light">
        <Text size="sm" fw={700}>
          Gagging is loud. Choking is silent.
        </Text>
        <Text size="sm" mt={4}>
          That single line separates the two more reliably than anything else.
          A baby making noise is moving air.
        </Text>
      </Alert>

      <Card withBorder padding="sm">
        <Table withRowBorders={false} verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th />
              <Table.Th>Gagging</Table.Th>
              <Table.Th>Choking</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td c="dimmed">Sound</Table.Td>
              <Table.Td>Loud — coughing, retching, sputtering</Table.Td>
              <Table.Td>Quiet or silent; weak or absent cough</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">Look</Table.Td>
              <Table.Td>Red face, watery eyes, tongue forward</Table.Td>
              <Table.Td>Panicked expression; lips or nails turning blue</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">What it is</Table.Td>
              <Table.Td>A protective reflex working correctly</Table.Td>
              <Table.Td>The airway is partly or fully blocked</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td c="dimmed">What to do</Table.Td>
              <Table.Td>Stay calm and let it happen. Don’t reach in.</Table.Td>
              <Table.Td>Emergency. Back blows and chest thrusts; call 911.</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Card>

      <Text size="sm">
        Never sweep a finger blindly into the mouth — it can push an object
        deeper. Remove only what you can actually see.
      </Text>

      <Text size="sm" c="dimmed">
        Frequent gagging early on is expected, not a warning sign: the gag
        reflex sits further forward in the mouth around six months and moves
        back with age. It fading is a sign of learning, not of risk.
      </Text>

      <Title order={3} mt="md">
        Before twelve months
      </Title>
      <Stack gap={6}>
        <Rule title="No honey" detail="Including any processed food containing it — infant botulism." />
        <Rule
          title="No cow’s milk as a drink"
          detail="Yoghurt and cheese from about six months are fine; it’s milk as a beverage that’s the problem."
        />
        <Rule title="No juice" detail="It displaces nutrient-dense calories." />
        <Rule title="No added sugar" detail="And keep salt low — early exposure sets lasting preferences." />
        <Rule
          title="Quarter round foods lengthwise"
          detail="Grapes, cherry tomatoes, large blueberries. Whole nuts, popcorn and thick globs of nut butter wait until about four."
        />
      </Stack>

      <Group gap="xs" mt="md">
        <Badge size="xs" color="teal" variant="light">
          Guideline
        </Badge>
        <Text size="xs">
          <Anchor
            href="https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/Choking-Prevention.aspx"
            target="_blank"
            rel="noreferrer"
          >
            AAP — Choking Prevention
          </Anchor>
        </Text>
      </Group>
      <Group gap="xs">
        <Badge size="xs" color="teal" variant="light">
          Guideline
        </Badge>
        <Text size="xs">
          <Anchor
            href="https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/foods-and-drinks-to-avoid-or-limit.html"
            target="_blank"
            rel="noreferrer"
          >
            CDC — Foods and drinks to avoid or limit
          </Anchor>
        </Text>
      </Group>

      <Text size="xs" c="dimmed" mt="md">
        This screen is a reminder, not training. An in-person infant CPR and
        choking course is worth the afternoon.
      </Text>
    </Stack>
  );
}

function Rule({ title, detail }) {
  return (
    <Card withBorder padding="xs">
      <Text size="sm" fw={600}>
        {title}
      </Text>
      <Text size="xs" c="dimmed">
        {detail}
      </Text>
    </Card>
  );
}
