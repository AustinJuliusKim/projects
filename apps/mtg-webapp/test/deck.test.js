import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCard,
  cardCount,
  deckIdentity,
  emptyDeck,
  groupByType,
  loadDeck,
  primaryType,
  removeCard,
} from "../src/deck.js";

const BOLT = {
  oracle_id: "bolt-id",
  name: "Lightning Bolt",
  type_line: "Instant",
  color_identity: ["R"],
};
const ELVES = {
  oracle_id: "elves-id",
  name: "Llanowar Elves",
  type_line: "Creature — Elf Druid",
  color_identity: ["G"],
};

test("add, increment, remove", () => {
  let deck = addCard(emptyDeck(), BOLT);
  deck = addCard(deck, BOLT);
  assert.equal(deck.cards["bolt-id"].qty, 2);
  assert.equal(cardCount(deck), 2);
  deck = removeCard(deck, "bolt-id");
  assert.equal(deck.cards["bolt-id"].qty, 1);
  deck = removeCard(deck, "bolt-id");
  assert.equal(deck.cards["bolt-id"], undefined);
  assert.equal(cardCount(deck), 0);
});

test("deck identity is WUBRG-ordered union", () => {
  let deck = addCard(addCard(emptyDeck(), ELVES), BOLT);
  assert.equal(deckIdentity(deck), "RG");
  assert.equal(deckIdentity(emptyDeck()), "");
});

test("primary type handles multiface and unknown lines", () => {
  assert.equal(primaryType("Instant"), "Instant");
  assert.equal(primaryType("Legendary Creature — Dwarf // Sorcery — Adventure"), "Creature");
  assert.equal(primaryType("Conspiracy"), "Other");
  assert.equal(primaryType(null), "Other");
});

test("groupByType orders groups and sorts names", () => {
  const deck = addCard(addCard(emptyDeck(), BOLT), ELVES);
  const groups = groupByType(deck);
  assert.deepEqual(
    groups.map((g) => g.type),
    ["Creature", "Instant"],
  );
});

test("loadDeck falls back to empty without localStorage", () => {
  assert.deepEqual(loadDeck(), emptyDeck());
});
