import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Chip, Group, Select, Pagination, Text, Stack, Alert } from "@mantine/core";

import { isAbortError, searchCards } from "../api.js";
import { addCard, loadDeck, saveDeck } from "../deck.js";
import CardGrid from "../components/CardGrid.jsx";
import { CardGridSkeleton } from "../components/Skeletons.jsx";

const COLORS = ["W", "U", "B", "R", "G"];
const FORMATS = ["", "commander", "modern", "standard", "pioneer", "legacy", "pauper", "vintage"];
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZES = [10, 25, 50, 100];

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const identity = params.get("identity") || "";
  const format = params.get("format") || "";
  const order = params.get("order") || "name";
  const page = Number(params.get("page") || 1);
  const pageSize = Number(params.get("page_size") || DEFAULT_PAGE_SIZE);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q && !identity && !format) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    searchCards(
      {
        q: q || null,
        identity: identity || null,
        format: format || null,
        order,
        page,
        page_size: pageSize,
      },
      { signal: controller.signal },
    )
      .then(setResult)
      .catch((e) => {
        if (!isAbortError(e)) setError(e.message);
      })
      .finally(() => {
        // An aborted request's finally fires after the superseding effect
        // already set loading=true — only the live request may clear it.
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [q, identity, format, order, page, pageSize]);

  function patch(next) {
    const merged = { q, identity, format, order, page_size: pageSize, ...next, page: next.page ?? 1 };
    setParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== "" && v !== null)),
    );
  }

  function toggleIdentity(selected) {
    // Chip.Group hands back whatever order was clicked; keep canonical
    // WUBRG order regardless, matching the original toggle behavior.
    patch({ identity: COLORS.filter((c) => selected.includes(c)).join("") });
  }

  function onAdd(card) {
    saveDeck(addCard(loadDeck(), card));
  }

  const pages = result ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1;

  return (
    <Stack>
      <Group gap="sm" wrap="wrap">
        <Chip.Group multiple value={identity.split("")} onChange={toggleIdentity}>
          <Group gap={6}>
            {COLORS.map((c) => (
              <Chip key={c} value={c} size="sm">
                {c}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <Select
          data={FORMATS.map((f) => ({ value: f, label: f || "any format" }))}
          value={format}
          onChange={(v) => patch({ format: v || "" })}
          w={160}
          allowDeselect={false}
          aria-label="Format"
        />
        <Select
          data={[
            { value: "name", label: "by name" },
            { value: "mv", label: "by mana value" },
            { value: "edhrec", label: "by popularity" },
          ]}
          value={order}
          onChange={(v) => patch({ order: v || "name" })}
          w={170}
          allowDeselect={false}
          aria-label="Order"
        />
        <Select
          data={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` }))}
          value={String(pageSize)}
          onChange={(v) => patch({ page_size: v ? Number(v) : DEFAULT_PAGE_SIZE })}
          w={140}
          allowDeselect={false}
          aria-label="Results per page"
        />
      </Group>

      {error && <Alert color="red">Search failed: {error}</Alert>}
      {!result && !error && !loading && (
        <Text c="dimmed">
          Search by rules text (“deals damage to each”), name, or type — then filter by color
          identity and format.
        </Text>
      )}
      {loading && <CardGridSkeleton count={Math.min(pageSize, 25)} />}
      {result && !loading && (
        <>
          <Text c="dimmed" size="sm">
            {result.total} cards
          </Text>
          <CardGrid cards={result.cards} onAdd={onAdd} />
          {pages > 1 && (
            <Group justify="center" mt="md">
              <Pagination
                siblings={1}
                boundaries={1}
                value={page}
                onChange={(p) => patch({ page: p })}
                total={pages}
              />
            </Group>
          )}
        </>
      )}
    </Stack>
  );
}
