import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, Combobox, Group, Image, Text, TextInput, useCombobox } from "@mantine/core";

import { autocomplete, isAbortError } from "../api.js";
import { displayCents } from "../money.js";
import { emptyState, parseSearchParams, searchHref, shouldSuggest } from "../searchState.js";
import { useStore } from "../storeContext.js";

const DEBOUNCE_MS = 150;

// Name suggestions for `text`: debounced, and each new keystroke aborts the
// request in flight so a slow stale response never overwrites a newer one.
function useSuggestions(slug, text) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const q = text.trim();
    if (!shouldSuggest(q)) {
      setItems([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      autocomplete(slug, q, { signal: controller.signal })
        .then((list) => {
          if (!controller.signal.aborted) setItems(list);
        })
        .catch((e) => {
          if (!isAbortError(e)) setItems([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug, text]);
  return items;
}

export default function SearchBox({ size = "md", autoFocus = false }) {
  const { slug, base } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const onSearchPage = location.pathname === `${base}/search`;
  const current = onSearchPage ? parseSearchParams(location.search) : null;
  const urlQ = current ? current.q : "";

  const [value, setValue] = useState(urlQ);
  const [typed, setTyped] = useState("");
  // Follow the URL (back/forward, chip removal) when it changes the query.
  useEffect(() => {
    if (onSearchPage) setValue(urlQ);
  }, [onSearchPage, urlQ]);

  const items = useSuggestions(slug, typed);
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });

  function submit(e) {
    e.preventDefault();
    combobox.closeDropdown();
    setTyped("");
    // A new query keeps the stock/catalog choice but starts filters over.
    const next = { ...emptyState(), q: value.trim(), mode: current ? current.mode : "stock" };
    navigate(searchHref(slug, next));
  }

  function pick(oracleId) {
    combobox.closeDropdown();
    setTyped("");
    navigate(`${base}/card/${oracleId}`);
  }

  return (
    <form onSubmit={submit} role="search">
      <Combobox store={combobox} onOptionSubmit={pick}>
        <Combobox.Target>
          <TextInput
            size={size}
            type="search"
            placeholder="Search cards — try “bolt” or t:dragon c:r"
            aria-label="Search cards"
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              setTyped(e.currentTarget.value);
              combobox.openDropdown();
              combobox.updateSelectedOptionIndex();
            }}
            onFocus={() => combobox.openDropdown()}
            onBlur={() => combobox.closeDropdown()}
          />
        </Combobox.Target>
        <Combobox.Dropdown hidden={items.length === 0}>
          <Combobox.Options>
            {items.map((it) => (
              <Combobox.Option value={it.oracle_id} key={it.oracle_id}>
                <Group gap="sm" wrap="nowrap">
                  {it.image_small ? (
                    <Image src={it.image_small} alt="" w={28} h={39} radius={2} loading="lazy" />
                  ) : null}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={500} truncate>
                      {it.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {it.type_line}
                    </Text>
                  </div>
                  {it.in_stock ? (
                    <Badge size="sm" color="green" variant="light">
                      {it.price_cents != null ? displayCents(it.price_cents) : "In stock"}
                    </Badge>
                  ) : (
                    <Text size="xs" c="dimmed">
                      Not in stock
                    </Text>
                  )}
                </Group>
              </Combobox.Option>
            ))}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>
    </form>
  );
}
