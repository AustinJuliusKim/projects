import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Group,
  Image,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

import { adjustInventory, isAbortError, suggestPrice } from "./api.js";
import { getPrintings, searchCards } from "./catalog.js";
import { displayCents } from "./money.js";
import {
  buildReceiveBody,
  centsToInput,
  CONDITIONS,
  finishOptions,
  isUuid,
  printingLabel,
} from "./receive.js";

// Receive stock: find a card in the catalog (mtg-api, directly), pick the
// exact printing/finish/condition, see the store's suggested price, and add
// the quantity with a price in one adjust.
export default function ReceivePage({ tenantId, locationId }) {
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState([]);
  const [oracleId, setOracleId] = useState(null);
  const [printings, setPrintings] = useState([]);
  const [printingId, setPrintingId] = useState(null);
  const [finish, setFinish] = useState("nonfoil");
  const [condition, setCondition] = useState("NM");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const printing = printings.find((p) => p.id === printingId) || null;
  const finishes = finishOptions(printing);

  // Card search, debounced.
  useEffect(() => {
    if (query.trim().length < 2) {
      setCards([]);
      return undefined;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      searchCards(query.trim(), { signal: ctrl.signal })
        .then((page) => setCards(page.cards))
        .catch((e) => {
          if (!isAbortError(e)) setError(`Card search failed: ${e.message}`);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // Printings of the chosen card.
  useEffect(() => {
    setPrintings([]);
    setPrintingId(null);
    if (!oracleId) return undefined;
    const ctrl = new AbortController();
    getPrintings(oracleId, { signal: ctrl.signal })
      .then((list) => {
        const paper = list.filter((p) => !p.digital);
        setPrintings(paper);
        if (paper.length === 1) setPrintingId(paper[0].id);
      })
      .catch((e) => {
        if (!isAbortError(e)) setError(`Loading printings failed: ${e.message}`);
      });
    return () => ctrl.abort();
  }, [oracleId]);

  // Keep the finish valid for the chosen printing.
  useEffect(() => {
    if (!finishes.includes(finish)) setFinish(finishes[0]);
  }, [finishes, finish]);

  // Suggested price from the POS API (the tenant's price rule over mtg-api).
  useEffect(() => {
    setSuggestion(null);
    if (!printingId || !isUuid(tenantId)) return undefined;
    const ctrl = new AbortController();
    suggestPrice(
      { printing_id: printingId, finish, condition },
      { signal: ctrl.signal },
    )
      .then((s) => {
        setSuggestion(s);
        if (!priceTouched) setPrice(centsToInput(s.suggested_cents));
      })
      .catch((e) => {
        if (!isAbortError(e)) setSuggestion({ error: e.message });
      });
    return () => ctrl.abort();
    // priceTouched deliberately not a dependency: typing a price shouldn't refetch.
  }, [printingId, finish, condition, tenantId]);

  async function submit() {
    setError(null);
    setDone(null);
    if (!isUuid(tenantId)) return setError("No store selected.");
    const { body, error: formError } = buildReceiveBody({
      locationId,
      printingId,
      condition,
      finish,
      qty,
      price,
    });
    if (formError) return setError(formError);
    setBusy(true);
    try {
      const result = await adjustInventory(body);
      setDone(result.item);
      setPriceTouched(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack maw={720}>
      <TextInput
        label="Find a card"
        placeholder="Lightning Bolt"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      {cards.length > 0 && (
        <Select
          label="Card"
          placeholder="Pick a card"
          data={cards.map((c) => ({ value: c.oracle_id, label: c.name }))}
          value={oracleId}
          onChange={setOracleId}
          searchable
        />
      )}
      {oracleId && printings.length === 0 && <Loader size="sm" />}
      {printings.length > 0 && (
        <Select
          label="Printing"
          placeholder="Pick a printing"
          data={printings.map((p) => ({ value: p.id, label: printingLabel(p) }))}
          value={printingId}
          onChange={setPrintingId}
          searchable
        />
      )}

      {printing && (
        <Group align="flex-start">
          {printing.image_small && (
            <Image src={printing.image_small} alt={printingLabel(printing)} w={146} radius="sm" />
          )}
          <Stack gap="sm">
            <div>
              <Text size="sm" fw={500}>Finish</Text>
              <SegmentedControl data={finishes} value={finish} onChange={setFinish} />
            </div>
            <div>
              <Text size="sm" fw={500}>Condition</Text>
              <SegmentedControl data={CONDITIONS} value={condition} onChange={setCondition} />
            </div>
            <NumberInput
              label="Quantity received"
              min={1}
              max={100000}
              allowDecimal={false}
              value={qty}
              onChange={setQty}
              w={180}
            />
            <TextInput
              label="Price ($)"
              description={suggestionText(suggestion)}
              placeholder="leave blank for unpriced"
              value={price}
              onChange={(e) => {
                setPrice(e.currentTarget.value);
                setPriceTouched(true);
              }}
              w={260}
            />
            <Button onClick={submit} loading={busy} w={180}>
              Receive
            </Button>
          </Stack>
        </Group>
      )}

      {error && <Alert color="red">{error}</Alert>}
      {done && (
        <Alert color="green">
          Saved: {done.qty} on hand at {displayCents(done.price_cents, { fallback: "unpriced" })}.
        </Alert>
      )}
    </Stack>
  );
}

function suggestionText(s) {
  if (!s) return "Suggested price: —";
  if (s.error) return `No suggestion: ${s.error}`;
  if (s.suggested_cents === null) return `No suggestion: ${s.note || "no USD price"}`;
  const stale = s.stale ? " (stale)" : "";
  return (
    `Suggested ${displayCents(s.suggested_cents)} from ${displayCents(s.reference_cents)} ` +
    `${s.reference_source} × ${s.multiplier_bp / 100}% · snapshot ${s.snapshot_id}${stale}`
  );
}
