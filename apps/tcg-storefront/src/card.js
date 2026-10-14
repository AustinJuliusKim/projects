// Card page data: GET /cards/{oracle_id} → {card, offers}. card.printings[]
// carries {id, set_code, set_name, collector_number, rarity, finishes,
// released_at, image_small, image_normal}; offers maps printing id → live
// offers {inventory_item_id, printing_id, game, condition, finish, lang,
// price_cents, available} read from Postgres (the truth, not the index).

const CONDITION_RANK = { NM: 0, LP: 1, MP: 2, HP: 3, DMG: 4 };
const FINISH_RANK = { nonfoil: 0, foil: 1, etched: 2 };

const rank = (table, v) => (v in table ? table[v] : 9);
const price = (o) => (Number.isSafeInteger(o.price_cents) ? o.price_cents : Infinity);

// Printing lookup by id.
export function printingsById(card) {
  const out = {};
  for (const p of (card && Array.isArray(card.printings) && card.printings) || []) {
    if (p && p.id) out[p.id] = p;
  }
  return out;
}

// One row per sellable offer, joined with its printing, cheapest first
// (then better condition, non-foil first, set name). Offers that can't be
// bought (no price, nothing available) are dropped. `printingId` narrows to
// one printing.
export function offerRows(card, offers, { printingId = null } = {}) {
  const byId = printingsById(card);
  const rows = [];
  for (const [pid, list] of Object.entries(offers || {})) {
    if (printingId && pid !== printingId) continue;
    for (const o of Array.isArray(list) ? list : []) {
      if (!o || !o.inventory_item_id) continue;
      if (!Number.isSafeInteger(o.price_cents) || !(o.available > 0)) continue;
      const p = byId[o.printing_id || pid] || {};
      rows.push({
        ...o,
        printing_id: o.printing_id || pid,
        set_code: p.set_code || null,
        set_name: p.set_name || null,
        collector_number: p.collector_number || null,
        rarity: p.rarity || null,
        image_small: p.image_small || null,
        image_normal: p.image_normal || null,
      });
    }
  }
  rows.sort(
    (a, b) =>
      price(a) - price(b) ||
      rank(CONDITION_RANK, a.condition) - rank(CONDITION_RANK, b.condition) ||
      rank(FINISH_RANK, a.finish) - rank(FINISH_RANK, b.finish) ||
      String(a.set_name || "").localeCompare(String(b.set_name || "")),
  );
  return rows;
}

// Printings newest first, each with its offer count and cheapest price.
export function printingSummaries(card, offers) {
  const list = ((card && Array.isArray(card.printings) && card.printings) || []).filter(
    (p) => p && p.id,
  );
  return list
    .map((p) => {
      const rows = offerRows(card, offers, { printingId: p.id });
      return {
        ...p,
        offerCount: rows.length,
        fromCents: rows.length ? rows[0].price_cents : null,
      };
    })
    .sort((a, b) => String(b.released_at || "").localeCompare(String(a.released_at || "")));
}

// Best image for the card, preferring the selected printing.
export function cardImage(card, printing = null) {
  return (
    (printing && printing.image_normal) ||
    (card && card.image_normal) ||
    (printing && printing.image_small) ||
    (card && card.image_small) ||
    null
  );
}

// The cart line for one offer row.
export function cartItem(card, row) {
  return {
    inventory_item_id: row.inventory_item_id,
    available: row.available,
    unit_price_cents: row.price_cents,
    oracle_id: (card && card.oracle_id) || null,
    name: (card && card.name) || null,
    printing_id: row.printing_id,
    set_code: row.set_code,
    set_name: row.set_name,
    collector_number: row.collector_number,
    finish: row.finish,
    condition: row.condition,
    lang: row.lang,
    image_small: row.image_small || (card && card.image_small) || null,
  };
}

// Plain-text summary for the meta description.
export function cardDescription(card, { storeName = "", fromCents = null, formatCents } = {}) {
  if (!card) return "";
  const parts = [card.name, card.type_line].filter(Boolean).join(" — ");
  const text = (card.oracle_text || "").replace(/\s+/g, " ").trim();
  const where = storeName ? ` at ${storeName}` : "";
  const price = fromCents !== null && formatCents ? ` From ${formatCents(fromCents)}${where}.` : "";
  const out = `${parts}.${price} ${text}`.trim();
  return out.length > 300 ? `${out.slice(0, 297)}…` : out;
}
