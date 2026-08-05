import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Stack, Paper, Group, ActionIcon, Text } from "@mantine/core";

import { getSimilar, isAbortError } from "../api.js";
import { logAction, logImpressions } from "../feedback.js";
import ConfidenceBadge from "./ConfidenceBadge.jsx";
import { SimilarRowsSkeleton } from "./Skeletons.jsx";

// The differentiator: mechanically synergistic suggestions with confidence
// and reasons. Impressions/clicks are logged from day one — training data
// for the eventual reranker.
export default function SimilarPanel({ oracleId, identity, context = "card_page", onAdd }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setResults(null);
    setError(null);
    const controller = new AbortController();
    getSimilar(oracleId, { limit: 12, identity: identity || null }, { signal: controller.signal })
      .then((r) => {
        setResults(r);
        logImpressions(oracleId, r, context);
      })
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      });
    return () => controller.abort();
  }, [oracleId, identity, context]);

  if (error) return <Text c="dimmed">Similar cards unavailable: {error}</Text>;
  if (results === null) return <SimilarRowsSkeleton />;
  if (!results.length) return <Text c="dimmed">No similar cards found.</Text>;

  return (
    <Stack gap="xs">
      {results.map((s) => (
        <Paper key={s.oracle_id} withBorder p="xs" radius="sm">
          <Group wrap="nowrap" gap="xs">
            <Text
              component={Link}
              to={`/card/${s.oracle_id}`}
              onClick={() => logAction("click", oracleId, s, context)}
              style={{ flex: 1 }}
              size="sm"
              fw={600}
            >
              {s.name}
            </Text>
            <ConfidenceBadge confidence={s.confidence} band={s.band} />
            {onAdd && (
              <ActionIcon
                onClick={() => {
                  logAction("deck_add", oracleId, s, context);
                  onAdd(s);
                }}
                title="Add to deck"
                variant="light"
                size="sm"
              >
                +
              </ActionIcon>
            )}
          </Group>
          {s.reasons.length > 0 && (
            <Text size="xs" c="dimmed" mt={4}>
              {s.reasons.join(" · ")}
            </Text>
          )}
        </Paper>
      ))}
    </Stack>
  );
}
