import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  TextInput,
  Stack,
  Card,
  Group,
  Text,
  Badge,
  Button,
  Checkbox,
  SegmentedControl,
  Affix,
  Paper,
} from "@mantine/core";

import { FOODS, FOODS_BY_ID, SEARCH_INDEX } from "../useLog.js";
import { searchFoods } from "../search.js";

const AGE_FILTERS = [
  ["all", "All"],
  ["6", "6m+"],
  ["9", "9m+"],
  ["12", "12m+"],
];

export default function BrowseView({ log }) {
  const [query, setQuery] = useState("");
  const [age, setAge] = useState("all");
  // Batch selection: a real meal is three or four foods at once, and making
  // that three or four separate interactions is the single most common
  // complaint about existing trackers.
  const [selected, setSelected] = useState([]);

  const results = useMemo(() => {
    // No debounce — the matcher is a pure function over a prebuilt index of a
    // few hundred items, so there is nothing to wait for.
    const ids = query.trim() ? searchFoods(SEARCH_INDEX, query) : FOODS.map((f) => f.id);
    return ids
      .map((id) => FOODS_BY_ID[id])
      .filter((f) => f && (age === "all" || f.firstOkMonths <= Number(age)));
  }, [query, age]);

  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const commit = (amount) => {
    log.logFoods(selected, amount);
    setSelected([]);
  };

  return (
    <Stack gap="sm" pt="md">
      <TextInput
        placeholder="Search foods…  (try 고구마)"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        size="md"
        autoComplete="off"
      />
      <SegmentedControl
        value={age}
        onChange={setAge}
        data={AGE_FILTERS.map(([value, label]) => ({ value, label }))}
        fullWidth
        size="xs"
      />

      {results.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" py="lg">
          Nothing matches “{query}”. No fuzzy guessing here — an empty result is
          the honest answer.
        </Text>
      )}

      {results.map((food) => {
        const s = log.status[food.id];
        return (
          <Card key={food.id} padding="sm" withBorder>
            <Group wrap="nowrap" align="flex-start">
              <Checkbox
                checked={selected.includes(food.id)}
                onChange={() => toggle(food.id)}
                aria-label={`Select ${food.name} to log`}
                mt={4}
              />
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Group gap="xs" wrap="wrap">
                  <Anchorish to={`/food/${food.id}`}>{food.name}</Anchorish>
                  {food.allergens?.length > 0 && (
                    <Badge size="xs" color="orange" variant="light">
                      allergen
                    </Badge>
                  )}
                  {food.nutrients?.ironType === "heme" && (
                    <Badge size="xs" color="red" variant="light">
                      heme iron
                    </Badge>
                  )}
                  {food.choking?.level === "modify-required" && (
                    <Badge size="xs" color="yellow" variant="light">
                      modify
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {food.category.replace(/_/g, " ")} · from {food.firstOkMonths}m
                  {s ? ` · tried ${s.count}×` : ""}
                </Text>
              </Stack>
            </Group>
          </Card>
        );
      })}

      {selected.length > 0 && (
        <Affix position={{ bottom: 80, left: 12, right: 12 }} className="bs-no-print">
          <Paper withBorder p="sm" shadow="md">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={600}>
                {selected.length} selected
              </Text>
              <Group gap="xs">
                <Button size="xs" variant="default" onClick={() => commit("none")}>
                  Refused
                </Button>
                <Button size="xs" variant="light" onClick={() => commit("tasted")}>
                  Tasted
                </Button>
                <Button size="xs" onClick={() => commit("some")}>
                  Ate it
                </Button>
              </Group>
            </Group>
          </Paper>
        </Affix>
      )}
    </Stack>
  );
}

function Anchorish({ to, children }) {
  return (
    <Text component={Link} to={to} fw={600} style={{ textDecoration: "none", color: "inherit" }}>
      {children}
    </Text>
  );
}
