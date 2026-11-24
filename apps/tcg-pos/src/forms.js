// Form validation + request bodies for the auth-era pages (pure, tested).
// Each returns { body } or { error }; the API validates again.

import { parseDollars } from "./receive.js";

// Mirror of auth/pins.pin_problem: 6 digits, not trivially guessable.
export function pinProblem(pin) {
  if (!/^[0-9]{6}$/.test(pin || "")) return "A PIN is exactly 6 digits.";
  for (const block of [1, 2, 3]) {
    if (pin === pin.slice(0, block).repeat(6 / block)) {
      return "That PIN is too easy to guess (repeated digits).";
    }
  }
  const steps = new Set();
  for (let i = 1; i < pin.length; i += 1) steps.add(Number(pin[i]) - Number(pin[i - 1]));
  if (steps.size === 1 && (steps.has(1) || steps.has(-1))) {
    return "That PIN is too easy to guess (a run of digits).";
  }
  return null;
}

export function buildPinBody(pin, confirm) {
  const problem = pinProblem(pin);
  if (problem) return { error: problem };
  if (pin !== confirm) return { error: "The two PINs don't match." };
  return { body: { pin } };
}

// direction: "add" | "remove"; amount: dollars text.
export function buildCreditAdjust({ direction, amount, reason }) {
  const cents = parseDollars(amount);
  if (cents === undefined || cents === null || cents === 0) {
    return { error: "Enter an amount in dollars, e.g. 12.50." };
  }
  const why = String(reason || "").trim();
  if (!why) return { error: "Give a reason (it goes in the ledger)." };
  return { body: { delta_cents: direction === "remove" ? -cents : cents, reason: why } };
}

export function buildInviteBody({ email, role }) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: "Enter an email address." };
  if (!role) return { error: "Pick a role." };
  return { body: { email: e, role } };
}

export function buildApiKeyBody({ name, perms }) {
  const n = String(name || "").trim();
  if (!n) return { error: "Name the key (what integration is it for?)." };
  if (!Array.isArray(perms) || perms.length === 0) return { error: "Pick at least one permission." };
  return { body: { name: n, perms: [...perms].sort() } };
}

export function buildStoreBody({ name, locationName }) {
  const n = String(name || "").trim();
  if (!n) return { error: "Name your store." };
  const loc = String(locationName || "").trim();
  return { body: loc ? { name: n, location_name: loc } : { name: n } };
}

export function buildRegisterBody({ locationId, name }, isUuid) {
  if (!isUuid(locationId || "")) return { error: "Enter the location ID (UUID) for this register." };
  const n = String(name || "").trim();
  if (!n) return { error: "Name the register, e.g. Front counter." };
  return { body: { location_id: locationId.trim(), name: n } };
}
