// Pure helpers for /v1/prices data (no React, no fetch) so they test under
// node --test. Prices arrive as integer cents keyed
// "<source>_<field>_<currency>"; nothing here converts currencies.

export const BATCH_MAX = 200;

// Preference order for the one number shown per currency.
const USD_KEYS = ["mtgjson_tcgplayer_retail_usd", "scryfall_usd_trend_usd"];
const EUR_KEYS = [
  "cardmarket_guide_trend_eur",
  "mtgjson_cardmarket_retail_eur",
  "scryfall_eur_trend_eur",
];

const firstPresent = (values, keys) => {
  for (const k of keys) if (values[k] != null) return values[k];
  return null;
};

export function chunk(items, size = BATCH_MAX) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function formatCents(cents, currency) {
  if (cents == null) return "—";
  const symbol = currency === "EUR" ? "€" : "$";
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

export function formatChange(change) {
  if (change == null) return "—";
  const pct = (change * 100).toFixed(1);
  return `${change > 0 ? "+" : ""}${pct}%`;
}

// Batch results -> { [printing_id]: { [finish]: { usd, eur, change7d } } }
// plus the snapshot id and the union of attributions to credit.
export function pricesByPrinting(responses) {
  const byPrinting = {};
  const attribution = new Set();
  let snapshotId = null;
  for (const resp of responses) {
    snapshotId = snapshotId || resp.snapshot_id;
    for (const result of resp.results) {
      for (const p of result.prices) {
        byPrinting[p.printing_id] ??= {};
        byPrinting[p.printing_id][p.finish] = {
          usd: firstPresent(p.open, USD_KEYS),
          eur: firstPresent(p.open, EUR_KEYS),
          change7d: p.change["7d"],
        };
        for (const a of p.attribution) attribution.add(a);
      }
    }
  }
  return { byPrinting, snapshotId, attribution: [...attribution].sort() };
}

// One table row's cells for a printing, falling back to the legacy
// Scryfall decimal columns when the price API has nothing for it.
export function printingPriceCells(printing, byPrinting) {
  const prices = byPrinting[printing.id];
  if (!prices) {
    const legacy = (v, cur) => (v != null ? formatCents(Math.round(v * 100), cur) : "—");
    return {
      usd: legacy(printing.price_usd, "USD"),
      usdFoil: legacy(printing.price_usd_foil, "USD"),
      eur: legacy(printing.price_eur, "EUR"),
      change7d: "—",
    };
  }
  const nonfoil = prices.nonfoil || {};
  const foil = prices.foil || prices.etched || {};
  return {
    usd: formatCents(nonfoil.usd ?? null, "USD"),
    usdFoil: formatCents(foil.usd ?? null, "USD"),
    eur: formatCents(nonfoil.eur ?? foil.eur ?? null, "EUR"),
    change7d: formatChange(nonfoil.change7d ?? foil.change7d ?? null),
  };
}
