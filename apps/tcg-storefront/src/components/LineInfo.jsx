import { Link } from "react-router-dom";
import { Anchor, Group, Image, Stack, Text } from "@mantine/core";

import { FINISH_LABELS } from "../facets.js";

// Name, printing and copy details for a cart or order line.
export default function LineInfo({ line, base }) {
  const details = [
    [line.set_code && line.set_code.toUpperCase(), line.collector_number && `#${line.collector_number}`]
      .filter(Boolean)
      .join(" "),
    line.condition,
    line.finish && line.finish !== "nonfoil" ? FINISH_LABELS[line.finish] || line.finish : null,
    line.lang && line.lang !== "en" ? line.lang.toUpperCase() : null,
  ].filter(Boolean);
  const name = line.name || "Card";
  return (
    <Group gap="sm" wrap="nowrap">
      {line.image_small ? (
        <Image src={line.image_small} alt="" w={40} h={56} radius={3} loading="lazy" />
      ) : null}
      <Stack gap={0} style={{ minWidth: 0 }}>
        {line.oracle_id && base ? (
          <Anchor component={Link} to={`${base}/card/${line.oracle_id}`} size="sm" fw={500}>
            {name}
          </Anchor>
        ) : (
          <Text size="sm" fw={500}>
            {name}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {details.join(" · ")}
        </Text>
      </Stack>
    </Group>
  );
}
