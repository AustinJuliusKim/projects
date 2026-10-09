// Money is integer cents end to end (the API never sends floats). This only
// formats for display; it never does arithmetic on dollars. USD-only for now.

// formatCents(123456) → "$1,234.56"; formatCents(-5) → "-$0.05".
// null/undefined means "unknown" (e.g. an unpriced item) and renders as the
// fallback, never as "$0.00". Non-integers throw: a float here is a bug
// upstream, and silently rounding it would hide that.
export function formatCents(cents, { fallback = "—" } = {}) {
  if (cents === null || cents === undefined) return fallback;
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError(`formatCents expects integer cents, got ${cents}`);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

// For rendering: like formatCents, but a bad value (a float, a string) shows
// as the dash instead of throwing and taking the whole page down. The
// strictness stays in formatCents; this is the display boundary.
export function displayCents(cents, { fallback = "—" } = {}) {
  try {
    return formatCents(cents, { fallback });
  } catch {
    return "—";
  }
}
