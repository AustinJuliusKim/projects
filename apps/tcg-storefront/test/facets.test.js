import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clauseChips,
  clauseLabel,
  facetGroups,
  isSelected,
  removeChip,
  removeRaw,
  toggleFacet,
  valueLabel,
} from "../src/facets.js";
import { parseSearchParams } from "../src/searchState.js";
import { stockSearch } from "./fixtures.js";

test("value labels", () => {
  assert.equal(valueLabel("colors", { value: "R" }), "Red");
  assert.equal(valueLabel("identity", "u"), "Blue");
  assert.equal(valueLabel("condition", "lp"), "Lightly Played");
  assert.equal(valueLabel("finish", "nonfoil"), "Non-foil");
  assert.equal(valueLabel("price", { value: "100-500", label: "$1–5" }), "$1–5");
  assert.equal(valueLabel("price", "10000-"), "$100+");
  assert.equal(valueLabel("set", "lea"), "LEA");
  assert.equal(valueLabel("rarity", "mythic"), "Mythic");
  assert.equal(valueLabel("keywords", "first strike"), "First Strike");
  assert.equal(valueLabel("format", null), "");
});

test("toggleFacet adds, removes case-insensitively, and drops empty facets", () => {
  let f = {};
  f = toggleFacet(f, "set", "lea");
  f = toggleFacet(f, "set", "leb");
  assert.deepEqual(f, { set: ["lea", "leb"] });
  assert.equal(isSelected(f, "set", "LEA"), true);
  f = toggleFacet(f, "set", "LEA");
  assert.deepEqual(f, { set: ["leb"] });
  f = toggleFacet(f, "set", "leb");
  assert.deepEqual(f, {});
});

test("facetGroups labels rows and skips empty facets", () => {
  const groups = facetGroups(stockSearch.facets);
  assert.deepEqual(
    groups.map((g) => g.name),
    ["set", "rarity", "finish", "condition", "price", "colors", "types"],
  );
  const cond = groups.find((g) => g.name === "condition");
  assert.equal(cond.label, "Condition");
  assert.deepEqual(cond.rows[1], { value: "LP", label: "Lightly Played", count: 0, selected: true });
  assert.equal(groups.find((g) => g.name === "price").rows[0].label, "$1–5");
});

test("chips: filters and facets, not plain words", () => {
  const chips = clauseChips(stockSearch.query.clauses);
  assert.deepEqual(
    chips.map((c) => [c.source, c.label]),
    [
      ["q", "Type: instant"],
      ["facet", "Condition: Near Mint or Lightly Played"],
    ],
  );
});

test("clause labels cover the syntax value shapes", () => {
  const c = (key, op, value, extra = {}) => clauseLabel({ key, op, value, raw: "", ...extra });
  assert.equal(c("c", ":", "RG"), "Color: Red, Green");
  assert.equal(c("c", ":", ""), "Color: Colorless");
  assert.equal(c("id", "<=", "M"), "Identity <= Multicolor");
  assert.equal(c("s", ":", { code: "ice", name: "ice age" }), "Set: ice age");
  assert.equal(c("mv", "<=", 4), "Mana value <= 4");
  assert.equal(c("usd", "<", 5), "Price < $5");
  assert.equal(c("usd", "<", 2.5), "Price < $2.50");
  assert.equal(c("cond", ">=", 4), "Condition >= LP");
  assert.equal(c("r", ">=", "rare"), "Rarity >= Rare");
  assert.equal(c("f", ":", "modern", { negated: true }), "not Legal in: Modern");
  assert.equal(c(null, ":", "draw a card", { phrase: true }), "“draw a card”");
  assert.equal(c(null, ":", "goblin", { negated: true }), "not “goblin”");
});

test("removeRaw removes one whole token", () => {
  assert.equal(removeRaw("bolt t:instant", "t:instant"), "bolt");
  assert.equal(removeRaw('o:"draw a card" t:instant', 'o:"draw a card"'), "t:instant");
  assert.equal(removeRaw("xt:instant t:instant", "t:instant"), "xt:instant");
  assert.equal(removeRaw("bolt", "t:x"), "bolt");
  assert.equal(removeRaw("bolt", ""), "bolt");
});

test("removeChip edits q or clears the facet, back to page 1", () => {
  const state = parseSearchParams("q=bolt+t%3Ainstant&condition=NM&condition=LP&page=3");
  const [typed, facet] = clauseChips(stockSearch.query.clauses);
  const a = removeChip(state, typed);
  assert.equal(a.q, "bolt");
  assert.equal(a.page, 1);
  const b = removeChip(state, facet);
  assert.deepEqual(b.facets, {});
  assert.equal(b.q, "bolt t:instant");
});
