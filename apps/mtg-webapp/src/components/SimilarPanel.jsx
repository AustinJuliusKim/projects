import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AspectRatio,
  ActionIcon,
  Badge,
  Card,
  Group,
  Image,
  Pagination,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";

import { getSimilar, isAbortError } from "../api.js";
import { logAction, logImpressions } from "../feedback.js";
import { pageSlice, unloggedItems } from "../paging.js";
import ConfidenceBadge from "./ConfidenceBadge.jsx";
import { SimilarGridSkeleton, SimilarRowsSkeleton } from "./Skeletons.jsx";

// Fetched once at the server max and paged client-side below — avoids a
// re-fetch on every page click, at the cost of a slightly bigger first
// response (50 results is still a small payload).
const FETCH_LIMIT = 50;
const PAGE_SIZE = 25;
const VIEW_STORAGE_KEY = "similarView";

// Read lazily (only when a panel actually mounts), same pattern as
// deck.js's loadDeck/saveDeck.
function loadSimilarView() {
  if (typeof localStorage === "undefined") return "grid";
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    return raw === "list" ? "list" : "grid"; // grid is the default
  } catch {
    return "grid";
  }
}

function saveSimilarView(view) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(VIEW_STORAGE_KEY, view);
}

function ViewSwitcher({ view, onChange }) {
  return (
    <SegmentedControl
      size="xs"
      data={[
        { label: "List", value: "list" },
        { label: "Grid", value: "grid" },
      ]}
      value={view}
      onChange={onChange}
      aria-label="Similar cards view"
    />
  );
}

// Below the name in both views: a combo's first product plus a "+N" chip
// for the rest (full list + count/popularity live in the title attr — no
// HoverCard yet, this pass). Falls back to the top mechanical reason when
// the pair has no known-combo relationship (`combo` null or, until the API
// deploys the field, simply absent — same fallback path either way).
function ComboChips({ suggestion }) {
  const combo = suggestion.combo;
  if (combo && combo.produces && combo.produces.length > 0) {
    const extra = combo.produces.length - 1;
    const title = `${combo.produces.join(", ")} — ${combo.count} known combo${
      combo.count === 1 ? "" : "s"
    }, ${combo.popularity} deck${combo.popularity === 1 ? "" : "s"}`;
    return (
      <Group gap={4} wrap="nowrap" mt={4}>
        <Badge
          variant="outline"
          color="grape"
          size="sm"
          title={title}
          style={{ textTransform: "none", flex: 1, minWidth: 0 }}
        >
          {combo.produces[0]}
        </Badge>
        {extra > 0 && (
          <Badge
            variant="outline"
            color="grape"
            size="sm"
            title={title}
            style={{ textTransform: "none", flexShrink: 0 }}
          >
            +{extra}
          </Badge>
        )}
      </Group>
    );
  }
  const reason = suggestion.reasons?.[0];
  if (!reason) return null;
  return (
    <Badge
      variant="outline"
      color="gray"
      size="sm"
      mt={4}
      style={{ textTransform: "none", maxWidth: "100%" }}
    >
      {reason}
    </Badge>
  );
}

function SimilarGridTile({ suggestion: s, oracleId, context, onAdd, onClick }) {
  return (
    <Card withBorder padding="sm" radius="md">
      <Card.Section>
        <Link to={`/card/${s.oracle_id}`} onClick={onClick}>
          {s.image_normal ? (
            <AspectRatio ratio={5 / 7}>
              <Image src={s.image_normal} alt={s.name} loading="lazy" />
            </AspectRatio>
          ) : (
            <Stack p="md" gap={4} mih={200} justify="center" align="center">
              <Text fw={700} ta="center">
                {s.name}
              </Text>
            </Stack>
          )}
        </Link>
      </Card.Section>
      <Group wrap="nowrap" gap="xs" mt="xs">
        <Text
          component={Link}
          to={`/card/${s.oracle_id}`}
          onClick={onClick}
          size="sm"
          fw={600}
          lineClamp={1}
          style={{ flex: 1, minWidth: 0 }}
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
      <ComboChips suggestion={s} />
    </Card>
  );
}

function SimilarRow({ suggestion: s, oracleId, context, onAdd, onClick }) {
  return (
    <Paper withBorder p="xs" radius="sm">
      <Group wrap="nowrap" gap="xs">
        <Text
          component={Link}
          to={`/card/${s.oracle_id}`}
          onClick={onClick}
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
  );
}

// The differentiator: mechanically synergistic suggestions with confidence
// and reasons. Impressions/clicks are logged from day one — training data
// for the eventual reranker.
export default function SimilarPanel({ oracleId, identity, context = "card_page", onAdd }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(loadSimilarView);
  const [page, setPage] = useState(1);
  // Which oracle_ids have already had an impression logged this mount —
  // reset whenever the seed/effect deps change and a fresh fetch starts.
  const loggedRef = useRef(new Set());

  useEffect(() => {
    setResults(null);
    setError(null);
    setPage(1);
    loggedRef.current = new Set();
    const controller = new AbortController();
    getSimilar(
      oracleId,
      { limit: FETCH_LIMIT, identity: identity || null },
      { signal: controller.signal },
    )
      .then((r) => setResults(r))
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      });
    return () => controller.abort();
  }, [oracleId, identity, context]);

  const totalPages = results ? Math.max(1, Math.ceil(results.length / PAGE_SIZE)) : 1;
  const visible = results ? pageSlice(results, page, PAGE_SIZE) : [];

  // Impression logging integrity: 50 results are fetched but only a page
  // (25) is ever shown — log only what's actually visible, once per result
  // per mount (paging.js's unloggedItems dedupes against loggedRef).
  useEffect(() => {
    if (!visible.length) return;
    const fresh = unloggedItems(visible, loggedRef.current);
    if (!fresh.length) return;
    for (const item of fresh) loggedRef.current.add(item.oracle_id);
    logImpressions(oracleId, fresh, context);
    // visible is derived from results/page each render; depending on those
    // directly (rather than the new `visible` array reference) avoids
    // re-running this effect on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, page, oracleId, context]);

  function changeView(next) {
    setView(next);
    saveSimilarView(next);
  }

  function handleClick(s) {
    logAction("click", oracleId, s, context);
  }

  if (error) return <Text c="dimmed">Similar cards unavailable: {error}</Text>;

  if (results === null) {
    return (
      <Stack gap="xs">
        <ViewSwitcher view={view} onChange={changeView} />
        {view === "grid" ? <SimilarGridSkeleton /> : <SimilarRowsSkeleton />}
      </Stack>
    );
  }

  if (!results.length) return <Text c="dimmed">No similar cards found.</Text>;

  return (
    <Stack gap="xs">
      <ViewSwitcher view={view} onChange={changeView} />
      {view === "grid" ? (
        <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5 }} spacing="md">
          {visible.map((s) => (
            <SimilarGridTile
              key={s.oracle_id}
              suggestion={s}
              oracleId={oracleId}
              context={context}
              onAdd={onAdd}
              onClick={() => handleClick(s)}
            />
          ))}
        </SimpleGrid>
      ) : (
        <Stack gap="xs">
          {visible.map((s) => (
            <SimilarRow
              key={s.oracle_id}
              suggestion={s}
              oracleId={oracleId}
              context={context}
              onAdd={onAdd}
              onClick={() => handleClick(s)}
            />
          ))}
        </Stack>
      )}
      {totalPages > 1 && (
        <Group justify="center" mt="xs">
          <Pagination
            size="sm"
            siblings={1}
            boundaries={1}
            value={page}
            onChange={setPage}
            total={totalPages}
          />
        </Group>
      )}
    </Stack>
  );
}
