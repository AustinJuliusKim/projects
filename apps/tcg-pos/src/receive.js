// Pure helpers for the Receive stock page (tested with node --test).

export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];
export const FINISHES = ["nonfoil", "foil", "etched"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s) => typeof s === "string" && UUID_RE.test(s.trim());

// "12.34" / "$1,234.5" / "7" → integer cents, by string surgery (no float
// math on money). "" → null (unpriced). Anything else → undefined (invalid).
export function parseDollars(input) {
  const text = String(input ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return null;
  const m = /^(\d{1,8})(?:\.(\d{0,2}))?$/.exec(text);
  if (!m) return undefined;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents <= 2 ** 31 - 1 ? cents : undefined;
}

// Cents → "12.34" for an editable input (inverse of parseDollars).
export function centsToInput(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) return "";
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// Finishes a printing is actually sold in, in our canonical order; falls
// back to all of them when the catalog doesn't say.
export function finishOptions(printing) {
  const listed = printing && Array.isArray(printing.finishes) ? printing.finishes : [];
  const known = FINISHES.filter((f) => listed.includes(f));
  return known.length > 0 ? known : FINISHES;
}

export function printingLabel(p) {
  const number = p.collector_number ? ` #${p.collector_number}` : "";
  return `${p.set_name || p.set_code.toUpperCase()} (${p.set_code.toUpperCase()})${number}`;
}

// Validate the form and build the POST /v1/inventory/adjust body.
// Returns { body } or { error }.
export function buildReceiveBody(form) {
  if (!isUuid(form.locationId || "")) return { error: "Enter a location ID (UUID)." };
  if (!form.printingId) return { error: "Pick a printing." };
  if (!CONDITIONS.includes(form.condition)) return { error: "Pick a condition." };
  if (!FINISHES.includes(form.finish)) return { error: "Pick a finish." };
  const qty = Number(form.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000) {
    return { error: "Quantity must be a whole number from 1 to 100000." };
  }
  const price = parseDollars(form.price);
  if (price === undefined) return { error: "Price must look like 12.34." };
  const body = {
    location_id: form.locationId.trim(),
    printing_id: form.printingId,
    condition: form.condition,
    finish: form.finish,
    delta: qty,
    reason: "received",
    channel: "adjustment",
  };
  if (price !== null) body.price_cents = price;
  return { body };
}
