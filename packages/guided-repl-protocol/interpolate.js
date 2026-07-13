/**
 * {{userName}} interpolation — the name-seeding mechanic from the Accounts &
 * Progress Spec. Fixtures carry the raw token everywhere; the player
 * substitutes at render time only (display changes, branch doesn't).
 *
 * Hard security rules (Lesson Engine Spec §2 interpolation rule): the user
 * name renders into a live HTML preview, so every value passes a charset
 * allowlist, a 30-char cap, HTML-escaping at markup sinks, and a safe
 * default on skip. The same sanitizer runs client-side at capture and
 * server-side on /api/leads.
 */

export const USER_NAME_TOKEN = "{{userName}}";
export const MAX_USER_NAME_LENGTH = 30;
export const DEFAULT_USER_NAME = "Demo User";

/**
 * Allowlist: must start with a letter/mark/digit; then letters, marks,
 * digits, spaces, and . ' - only. No HTML metacharacters can pass.
 */
export const USER_NAME_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'-]*$/u;

/**
 * Sanitizes a raw captured name: trim, collapse internal whitespace,
 * truncate to MAX_USER_NAME_LENGTH, then test the allowlist.
 *
 * @param {unknown} raw
 * @returns {string|null} the sanitized name, or null when invalid/empty
 */
export function sanitizeUserName(raw) {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ").slice(0, MAX_USER_NAME_LENGTH);
  if (collapsed === "") return null;
  return USER_NAME_RE.test(collapsed) ? collapsed : null;
}

/**
 * Escapes the five HTML metacharacters (& < > " ') — apostrophe included
 * because interpolated values may land inside attribute values.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Replaces every {{userName}} token in `text` with the given name (or the
 * safe default). `html: true` HTML-escapes the value first — use it for
 * markup sinks (preview srcDoc, inlined preview files); text sinks rendered
 * through React rely on React's own escaping and use the default text mode.
 *
 * @param {string} text
 * @param {string|null|undefined} name sanitized user name, if any
 * @param {{html?: boolean}} [opts]
 * @returns {string}
 */
export function interpolateUserName(text, name, { html = false } = {}) {
  if (typeof text !== "string" || !text.includes(USER_NAME_TOKEN)) return text;
  const value = name || DEFAULT_USER_NAME;
  return text.replaceAll(USER_NAME_TOKEN, html ? escapeHtml(value) : value);
}
