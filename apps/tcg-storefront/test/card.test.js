import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cardDescription,
  cardImage,
  cartItem,
  offerRows,
  printingSummaries,
} from "../src/card.js";
import { formatCents } from "../src/money.js";
import { canonicalHref, pageTitle } from "../src/seo.js";
import { cardDetail, ITEM_A, ITEM_B, ITEM_C, PRINT_LEA, PRINT_M10 } from "./fixtures.js";

const { card, offers } = cardDetail;

test("offer rows join printings, cheapest and best condition first", () => {
  const rows = offerRows(card, offers);
  assert.deepEqual(
    rows.map((r) => [r.inventory_item_id, r.set_code, r.condition, r.finish, r.price_cents]),
    [
      [ITEM_A, "m10", "NM", "nonfoil", 199],
      [ITEM_B, "m10", "LP", "foil", 199],
      [ITEM_C, "lea", "HP", "nonfoil", 45000],
    ],
  );
  assert.equal(rows[2].set_name, "Limited Edition Alpha");
  assert.deepEqual(
    offerRows(card, offers, { printingId: PRINT_LEA }).map((r) => r.inventory_item_id),
    [ITEM_C],
  );
});

test("offer rows drop unbuyable offers and tolerate junk", () => {
  const junk = {
    [PRINT_M10]: [
      { inventory_item_id: "x", price_cents: null, available: 2 },
      { inventory_item_id: "y", price_cents: 100, available: 0 },
      null,
    ],
    other: "nope",
  };
  assert.deepEqual(offerRows(card, junk), []);
  assert.deepEqual(offerRows(null, null), []);
});

test("printing summaries: newest first with offer counts", () => {
  const s = printingSummaries(card, offers);
  assert.deepEqual(
    s.map((p) => [p.set_code, p.offerCount, p.fromCents]),
    [
      ["m10", 2, 199],
      ["lea", 1, 45000],
    ],
  );
});

test("cart item from an offer row", () => {
  const [row] = offerRows(card, offers);
  assert.deepEqual(cartItem(card, row), {
    inventory_item_id: ITEM_A,
    available: 4,
    unit_price_cents: 199,
    oracle_id: card.oracle_id,
    name: "Lightning Bolt",
    printing_id: PRINT_M10,
    set_code: "m10",
    set_name: "Magic 2010",
    collector_number: "146",
    finish: "nonfoil",
    condition: "NM",
    lang: "en",
    image_small: "https://cards.scryfall.io/small/m10.jpg",
  });
});

test("card image prefers the selected printing (hotlinked, as given)", () => {
  assert.equal(cardImage(card), card.image_normal);
  assert.equal(cardImage(card, card.printings[0]), "https://cards.scryfall.io/normal/lea.jpg");
  assert.equal(cardImage({}, null), null);
});

test("description and titles", () => {
  const d = cardDescription(card, { storeName: "Demo", fromCents: 199, formatCents });
  assert.equal(
    d,
    "Lightning Bolt — Instant. From $1.99 at Demo. Lightning Bolt deals 3 damage to any target.",
  );
  assert.equal(cardDescription(null), "");
  assert.ok(cardDescription({ name: "X", oracle_text: "y".repeat(500) }).length <= 300);
  assert.equal(pageTitle(["Lightning Bolt"], "Demo Games"), "Lightning Bolt · Demo Games");
  assert.equal(pageTitle([], ""), "Card shop");
  assert.equal(
    canonicalHref("https://x.test", "/s/demo/search", "?q=bolt&page=3&set=lea", ["q", "mode"]),
    "https://x.test/s/demo/search?q=bolt",
  );
  assert.equal(canonicalHref("https://x.test", "/s/demo"), "https://x.test/s/demo");
});
