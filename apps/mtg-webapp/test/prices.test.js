import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chunk,
  formatCents,
  formatChange,
  pricesByPrinting,
  printingPriceCells,
} from "../src/prices.js";

const price = (printing_id, finish, open, change7d = null) => ({
  printing_id,
  finish,
  open,
  change: { "1d": null, "7d": change7d, "30d": null },
  attribution: ["MTGJSON", "Cardmarket"],
});

test("formatCents keeps integer cents exact and nulls as a dash", () => {
  assert.equal(formatCents(1410, "USD"), "$14.10");
  assert.equal(formatCents(7, "EUR"), "€0.07");
  assert.equal(formatCents(0, "USD"), "$0.00");
  assert.equal(formatCents(null, "USD"), "—");
});

test("formatChange signs and rounds", () => {
  assert.equal(formatChange(0.0842), "+8.4%");
  assert.equal(formatChange(-0.021), "-2.1%");
  assert.equal(formatChange(null), "—");
});

test("chunk splits at the batch limit", () => {
  const items = Array.from({ length: 450 }, (_, i) => i);
  assert.deepEqual(
    chunk(items).map((c) => c.length),
    [200, 200, 50],
  );
});

test("pricesByPrinting prefers TCGplayer USD and the Cardmarket guide EUR", () => {
  const { byPrinting, snapshotId, attribution } = pricesByPrinting([
    {
      snapshot_id: "2026-10-09.1",
      results: [
        {
          prices: [
            price(
              "a",
              "nonfoil",
              {
                scryfall_usd_trend_usd: 100,
                mtgjson_tcgplayer_retail_usd: 120,
                mtgjson_cardmarket_retail_eur: 90,
                cardmarket_guide_trend_eur: 95,
              },
              0.05,
            ),
            price("a", "foil", { scryfall_usd_trend_usd: 400 }),
          ],
        },
      ],
    },
  ]);
  assert.equal(snapshotId, "2026-10-09.1");
  assert.deepEqual(attribution, ["Cardmarket", "MTGJSON"]);
  assert.deepEqual(byPrinting.a.nonfoil, { usd: 120, eur: 95, change7d: 0.05 });
  assert.equal(byPrinting.a.foil.usd, 400);
});

test("printingPriceCells uses the price API, else legacy Scryfall columns", () => {
  const byPrinting = {
    a: { nonfoil: { usd: 120, eur: null, change7d: 0.05 }, foil: { usd: 400, eur: 300 } },
  };
  assert.deepEqual(printingPriceCells({ id: "a" }, byPrinting), {
    usd: "$1.20",
    usdFoil: "$4.00",
    eur: "€3.00",
    change7d: "+5.0%",
  });
  assert.deepEqual(
    printingPriceCells({ id: "b", price_usd: 0.77, price_usd_foil: null, price_eur: 0.6 }, {}),
    { usd: "$0.77", usdFoil: "—", eur: "€0.60", change7d: "—" },
  );
});
