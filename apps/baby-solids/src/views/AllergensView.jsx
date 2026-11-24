import { Link } from "react-router-dom";
import { Stack, Title, Text, Card, Group, Badge, Progress, Alert, Anchor, Button } from "@mantine/core";

import { FOODS_BY_ID } from "../useLog.js";

/**
 * The allergen maintenance view.
 *
 * Introduction is the part every app tracks. Sustained re-exposure is the part
 * that actually carries the benefit, and it's the part nobody schedules —
 * CSACI's position is that occasional exposure after introduction may be worse
 * than none at all. So this screen is a decay clock, not a checklist.
 */
export default function AllergensView({ log }) {
  const due = log.allergens.filter((a) => a.dueToday);

  return (
    <Stack gap="md" pt="md">
      <Title order={2}>Allergens</Title>

      {due.length > 0 && (
        <Alert color="violet" variant="light" title="Due today">
          <Text size="sm">
            {due.map((a) => a.allergen).join(", ")} — behind the weekly target.
          </Text>
        </Alert>
      )}

      <Text size="xs" c="dimmed">
        Target is at least once a week per allergen, and around 2 g of protein
        across three or more servings for peanut. That floor is expert opinion
        rather than a trial result — it is the cadence clinicians converge on,
        not a number a study measured.
      </Text>

      {log.allergens.length === 0 && (
        <Text c="dimmed" size="sm">
          No allergen foods in the canon yet.
        </Text>
      )}

      {log.allergens.map((a) => {
        const plan = log.plans.find((p) => p.allergen === a.allergen);
        const food = plan ? FOODS_BY_ID[plan.foodId] : null;
        const started = a.status !== "not_started";
        const pct = Math.min(100, (a.sessionsLast7d / a.targetSessions) * 100);
        return (
          <Card key={a.allergen} withBorder padding="sm">
            <Group justify="space-between" mb={4}>
              <Text fw={700} tt="capitalize">
                {a.allergen}
              </Text>
              <Badge
                size="sm"
                variant="light"
                color={!started ? "gray" : a.dueToday ? "orange" : "teal"}
              >
                {started ? `${a.sessionsLast7d} / ${a.targetSessions} this week` : "not started"}
              </Badge>
            </Group>

            {started && (
              <Progress value={pct} size="sm" color={a.dueToday ? "orange" : "teal"} mb={6} />
            )}

            <Text size="xs" c="dimmed">
              {started ? (
                <>
                  {a.lastAt
                    ? `Last served ${a.daysSinceLast === 0 ? "today" : `${a.daysSinceLast} day${a.daysSinceLast === 1 ? "" : "s"} ago`}.`
                    : "Never served."}{" "}
                  Rolling seven days, not a weekly reset.
                </>
              ) : (
                <>
                  The clock starts once you serve it — until then this is a decision to make, not
                  something you are behind on.
                </>
              )}
            </Text>

            {!started && plan?.medicalGate && (
              <Text size="xs" c="dimmed" mt={6} fs="italic">
                {plan.medicalGate}
              </Text>
            )}

            {food && (
              <Group mt="sm" gap="xs">
                <Anchor component={Link} to={`/food/${food.id}`} size="sm">
                  {food.name}
                </Anchor>
                <Button size="xs" onClick={() => log.logFoods([food.id], "some")}>
                  Log a serving
                </Button>
              </Group>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}
