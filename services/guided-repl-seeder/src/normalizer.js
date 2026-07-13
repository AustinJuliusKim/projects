/**
 * Frame-level normalization: rewrites absolute filesystem paths that leak
 * into frame payloads (from tool_use inputs, tool_result output, etc.) into
 * portable, redacted forms so recorded fixtures are safe to publish.
 *
 * Rules:
 *   - strings under the run's workspace cwd -> workspace-relative (no leading "/")
 *   - strings under the user's home dir (but outside the workspace, e.g. a
 *     plan file written to ~/.claude/plans/<name>.md) -> "~/" + home-relative,
 *     with the plan filename itself normalized to "plan.md"
 *   - UUIDs, `sk-ant-*` key-shaped strings, email addresses, and any
 *     leftover /Users or /private/tmp path fall back to opaque placeholders
 *   - the standalone username token (home-dir basename) and the
 *     dash-mangled form of the workspace cwd (as used by Claude Code's
 *     `~/.claude/projects/<dash-mangled-cwd>` naming) are also redacted
 */

import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Best-effort lookup of the OS account's full display name (e.g. macOS
 * "Real Name" via `id -F`), so it can be redacted from recorded fixtures
 * the same way the username token is. Never throws: returns undefined if
 * the platform doesn't support this or the lookup fails.
 *
 * @returns {string | undefined}
 */
function getOsFullName() {
  try {
    const out = execFileSync("id", ["-F"], { encoding: "utf8" }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_FULL_NAME = getOsFullName();

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PLAN_FILE_RE = /(~\/\.claude\/plans\/)[^/\s"']+\.md/g;
const VAR_FOLDERS_CATCHALL_RE = /-private-var-folders-[^/\s"']*/g;

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitizes a single string value: rewrites absolute paths and redacts
 * uuid/key-shaped substrings.
 *
 * @param {string} str
 * @param {{cwd: string, home?: string, fullName?: string}} ctx
 * @returns {string}
 */
export function sanitizeString(str, ctx) {
  const { cwd, home = os.homedir(), fullName = DEFAULT_FULL_NAME } = ctx;
  let s = str;

  if (fullName) {
    const fullNameRe = new RegExp(`\\b${escapeRegExp(fullName)}\\b`, "g");
    // Interpolation token, not a literal: the player substitutes the
    // learner's captured name at render time ("Demo User" when anonymous).
    s = s.replace(fullNameRe, "{{userName}}");
  }

  if (cwd) {
    const cwdDashRe = new RegExp(escapeRegExp(cwd.replace(/\//g, "-")), "g");
    s = s.replace(cwdDashRe, "<path>");

    const cwdRe = new RegExp(escapeRegExp(cwd) + "/?", "g");
    s = s.replace(cwdRe, "");
  }
  if (home) {
    const homeRe = new RegExp(escapeRegExp(home), "g");
    s = s.replace(homeRe, "~");

    const username = path.basename(home);
    if (username) {
      const usernameRe = new RegExp(`\\b${escapeRegExp(username)}\\b`, "g");
      s = s.replace(usernameRe, "<user>");
    }
  }

  s = s.replace(PLAN_FILE_RE, "$1plan.md");
  s = s.replace(UUID_RE, "<uuid>");
  s = s.replace(KEY_RE, "<redacted-key>");
  s = s.replace(EMAIL_RE, "<email>");
  s = s.replace(/\/Users\/[^\s"']*/g, "<path>");
  s = s.replace(/\/private\/[^\s"']*/g, "<path>");
  s = s.replace(/\/var\/folders\/[^\s"']*/g, "<path>");
  s = s.replace(VAR_FOLDERS_CATCHALL_RE, "<path>");

  return s;
}

/**
 * Deep-sanitizes all string values in a plain-JSON value.
 *
 * @param {unknown} value
 * @param {{cwd: string, home?: string, fullName?: string}} ctx
 * @returns {unknown}
 */
function deepSanitize(value, ctx) {
  if (typeof value === "string") return sanitizeString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => deepSanitize(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepSanitize(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Normalizes one ServerFrame in place (returns a new object).
 *
 * @param {import("@guided-repl/protocol").ServerFrame} frame
 * @param {{cwd: string, home?: string, fullName?: string}} ctx
 * @returns {import("@guided-repl/protocol").ServerFrame}
 */
export function normalizeFrame(frame, ctx) {
  if (!frame || typeof frame !== "object") return frame;
  if (!("payload" in frame)) return frame;
  return { ...frame, payload: deepSanitize(frame.payload, ctx) };
}
