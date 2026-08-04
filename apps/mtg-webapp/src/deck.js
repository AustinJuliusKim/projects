// Deck model: pure functions over a plain object, localStorage persistence
// kept at the edges so everything here runs under node --test.

const STORAGE_KEY = "mtg-webapp:deck";

export function emptyDeck() {
  return { name: "New Deck", cards: {} };
}

export function addCard(deck, card, qty = 1) {
  const existing = deck.cards[card.oracle_id];
  const entry = existing
    ? { ...existing, qty: existing.qty + qty }
    : {
        oracle_id: card.oracle_id,
        name: card.name,
        type_line: card.type_line || "",
        mana_value: card.mana_value ?? null,
        color_identity: card.color_identity || [],
        image_small: card.image_small || null,
        qty,
      };
  return { ...deck, cards: { ...deck.cards, [card.oracle_id]: entry } };
}

export function removeCard(deck, oracleId) {
  const cards = { ...deck.cards };
  const entry = cards[oracleId];
  if (!entry) return deck;
  if (entry.qty > 1) cards[oracleId] = { ...entry, qty: entry.qty - 1 };
  else delete cards[oracleId];
  return { ...deck, cards };
}

export function cardCount(deck) {
  return Object.values(deck.cards).reduce((n, c) => n + c.qty, 0);
}

// Union of color identities — the commander-sense filter for suggestions.
export function deckIdentity(deck) {
  const identity = new Set();
  for (const card of Object.values(deck.cards)) {
    for (const color of card.color_identity || []) identity.add(color);
  }
  return "WUBRG".split("").filter((c) => identity.has(c)).join("");
}

const TYPE_ORDER = [
  "Creature",
  "Planeswalker",
  "Battle",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Land",
];

export function primaryType(typeLine) {
  const face = (typeLine || "").split("//")[0];
  for (const t of TYPE_ORDER) if (face.includes(t)) return t;
  return "Other";
}

export function groupByType(deck) {
  const groups = {};
  for (const card of Object.values(deck.cards)) {
    const t = primaryType(card.type_line);
    (groups[t] ??= []).push(card);
  }
  for (const t of Object.keys(groups)) groups[t].sort((a, b) => a.name.localeCompare(b.name));
  return [...TYPE_ORDER, "Other"]
    .filter((t) => groups[t])
    .map((t) => ({ type: t, cards: groups[t] }));
}

export function loadDeck() {
  if (typeof localStorage === "undefined") return emptyDeck();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : emptyDeck();
  } catch {
    return emptyDeck();
  }
}

export function saveDeck(deck) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deck));
}
