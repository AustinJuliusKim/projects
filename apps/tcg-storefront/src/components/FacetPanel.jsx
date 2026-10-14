import { useState } from "react";
import { Anchor, Checkbox, Group, Stack, Text, UnstyledButton } from "@mantine/core";

import { facetGroups } from "../facets.js";

const COLLAPSED_ROWS = 8;

function FacetGroup({ group, onToggle, onClear }) {
  const [expanded, setExpanded] = useState(false);
  const anySelected = group.rows.some((r) => r.selected);
  // Selected rows always show, even past the fold.
  const rows = expanded
    ? group.rows
    : group.rows.filter((r, i) => i < COLLAPSED_ROWS || r.selected);
  return (
    <Stack gap={6} component="fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
      <Group justify="space-between" component="legend" w="100%" p={0}>
        <Text fw={600} size="sm">
          {group.label}
        </Text>
        {anySelected && (
          <UnstyledButton onClick={() => onClear(group.name)} aria-label={`Clear ${group.label}`}>
            <Text size="xs" c="dimmed">
              Clear
            </Text>
          </UnstyledButton>
        )}
      </Group>
      {rows.map((row) => (
        <Checkbox
          key={row.value}
          size="xs"
          checked={row.selected}
          onChange={() => onToggle(group.name, row.value)}
          label={
            <Group gap={6} wrap="nowrap">
              <Text size="sm">{row.label}</Text>
              <Text size="xs" c="dimmed">
                {row.count}
              </Text>
            </Group>
          }
        />
      ))}
      {group.rows.length > rows.length && (
        <Anchor component="button" type="button" size="xs" onClick={() => setExpanded(true)}>
          Show all {group.rows.length}
        </Anchor>
      )}
    </Stack>
  );
}

// The facet sidebar: every facet the response returned, multi-select.
export default function FacetPanel({ facets, onToggle, onClear }) {
  const groups = facetGroups(facets);
  if (!groups.length) return null;
  return (
    <Stack gap="lg">
      {groups.map((g) => (
        <FacetGroup key={g.name} group={g} onToggle={onToggle} onClear={onClear} />
      ))}
    </Stack>
  );
}
