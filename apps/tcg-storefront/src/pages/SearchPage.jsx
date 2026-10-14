import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Drawer,
  Grid,
  Group,
  Pagination,
  Pill,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";

import { isAbortError, searchStore } from "../api.js";
import CardGrid, { CardGridSkeleton } from "../components/CardGrid.jsx";
import FacetPanel from "../components/FacetPanel.jsx";
import { clauseChips, clearFacet, removeChip, toggleFacet } from "../facets.js";
import {
  emptyState,
  pageCount,
  parseSearchParams,
  patchState,
  SORT_LABELS,
  SORTS,
  toRequestParams,
  toSearchParams,
} from "../searchState.js";
import { pageTitle } from "../seo.js";
import { useStore } from "../storeContext.js";
import { useSeo } from "../useSeo.js";

const SORT_OPTIONS = SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }));
const MODE_OPTIONS = [
  { value: "stock", label: "In stock" },
  { value: "catalog", label: "All cards" },
];

export default function SearchPage() {
  const { slug, base, store } = useStore();
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const state = useMemo(() => parseSearchParams(key), [key]);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    searchStore(slug, toRequestParams(state), { signal: controller.signal })
      .then(setResult)
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      })
      .finally(() => {
        // Only the live request may clear loading (see mtg-webapp SearchPage).
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [slug, state]);

  const go = (next) => {
    setParams(toSearchParams(next));
    window.scrollTo({ top: 0 });
  };
  const patch = (p) => go(patchState(state, p));
  const onToggle = (name, value) => patch({ facets: toggleFacet(state.facets, name, value) });
  const onClear = (name) => patch({ facets: clearFacet(state.facets, name) });

  useSeo({
    title: pageTitle([state.q ? `“${state.q}”` : "Search"], store.display_name),
    description: state.q
      ? `${store.display_name}: cards matching “${state.q}”.`
      : `Browse ${store.display_name}'s singles.`,
    keep: ["q", "mode"],
  });

  const chips = result ? clauseChips(result.query && result.query.clauses) : [];
  const pages = result ? pageCount(result.total, result.page_size) : 1;
  const facets = result ? result.facets : {};
  const filterCount = Object.values(state.facets).reduce((n, v) => n + v.length, 0);
  const panel = <FacetPanel facets={facets} onToggle={onToggle} onClear={onClear} />;

  return (
    <Grid gutter="xl">
      <Grid.Col span={{ base: 12, md: 3 }} visibleFrom="md">
        {panel}
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 9 }}>
        <Stack gap="md">
          <Group justify="space-between" gap="sm">
            <SegmentedControl
              data={MODE_OPTIONS}
              value={state.mode}
              onChange={(mode) => patch({ mode })}
              aria-label="Search in"
            />
            <Group gap="sm">
              <Button
                variant="default"
                hiddenFrom="md"
                onClick={() => setFiltersOpen(true)}
              >
                Filters{filterCount ? ` (${filterCount})` : ""}
              </Button>
              <Select
                data={SORT_OPTIONS}
                value={state.sort}
                onChange={(sort) => patch({ sort: sort || "relevance" })}
                allowDeselect={false}
                aria-label="Sort by"
                w={190}
              />
            </Group>
          </Group>

          {chips.length > 0 && (
            <Group gap={6}>
              {chips.map((chip) => (
                <Pill
                  key={chip.id}
                  size="md"
                  withRemoveButton
                  onRemove={() => go(removeChip(state, chip))}
                >
                  {chip.label}
                </Pill>
              ))}
              <Anchor
                component="button"
                type="button"
                size="sm"
                onClick={() => go({ ...emptyState(), mode: state.mode, sort: state.sort })}
              >
                Clear all
              </Anchor>
            </Group>
          )}

          {result && result.did_you_mean && (
            <Text>
              {result.corrected ? (
                <>
                  Showing results for <b>{result.did_you_mean}</b>
                  {result.q ? <> — no close match for “{result.q}”</> : null}.
                </>
              ) : (
                <>
                  Did you mean{" "}
                  <Anchor
                    component="button"
                    type="button"
                    onClick={() => patch({ q: result.did_you_mean })}
                  >
                    {result.did_you_mean}
                  </Anchor>
                  ?
                </>
              )}
            </Text>
          )}
          {result &&
            (result.warnings || []).map((w) => (
              <Text key={w} size="xs" c="dimmed">
                {w}
              </Text>
            ))}

          {error && <Alert color="red">Search failed: {error}</Alert>}
          {!result && loading && <CardGridSkeleton count={12} />}
          {result && (
            <Box style={{ opacity: loading ? 0.5 : 1, transition: "opacity 120ms" }} aria-busy={loading}>
              <Stack gap="md">
                <Text size="sm" c="dimmed">
                  {result.total.toLocaleString("en-US")} card{result.total === 1 ? "" : "s"}
                  {state.mode === "stock" ? " in stock" : ""}
                </Text>
                {result.results.length > 0 ? (
                  <CardGrid cards={result.results} base={base} mode={result.mode} />
                ) : (
                  <NoResults state={state} onCatalog={() => patch({ mode: "catalog" })} />
                )}
                {pages > 1 && (
                  <Group justify="center" mt="md">
                    <Pagination
                      total={pages}
                      value={Math.min(result.page, pages)}
                      onChange={(page) => patch({ page })}
                      siblings={1}
                      boundaries={1}
                    />
                  </Group>
                )}
              </Stack>
            </Box>
          )}
        </Stack>
      </Grid.Col>
      <Drawer
        opened={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        hiddenFrom="md"
        size="sm"
      >
        {panel}
      </Drawer>
    </Grid>
  );
}

function NoResults({ state, onCatalog }) {
  return (
    <Stack gap="xs" py="lg">
      <Text fw={500}>No cards found.</Text>
      {state.mode === "stock" && (
        <Text size="sm" c="dimmed">
          Nothing in stock matches.{" "}
          <Anchor component="button" type="button" onClick={onCatalog}>
            Search all cards
          </Anchor>{" "}
          to see what exists.
        </Text>
      )}
    </Stack>
  );
}
