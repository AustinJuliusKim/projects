/**
 * Preview support: classify previewable files and rewrite same-workspace
 * `<link|script|img>` refs to `data:` URIs so an iframe's `srcDoc` can load
 * them without network access.
 *
 * Regex-not-DOMParser is deliberate: node:test has no DOM available, and the
 * fixture HTML this feature targets is curated/well-formed. A future BYOK
 * (bring-your-own-content) path would need a real HTML parser here — this is
 * a documented limitation, not an oversight.
 */

import { normalizePath, getFile } from "./virtualFs.js";

/**
 * Classifies a file path for preview purposes.
 *
 * @param {string} path
 * @returns {"html"|"markdown"|"js"|null}
 */
export function fileKind(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "js" || ext === "jsx") return "js";
  return null;
}

/**
 * Naive MIME lookup for the file extension of a resolved ref path, used only
 * to label the data: URI. Falls back to a generic binary type.
 *
 * @param {string} path
 * @returns {string}
 */
function mimeFor(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "css":
      return "text/css";
    case "js":
      return "text/javascript";
    case "json":
      return "application/json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "text/plain";
  }
}

/**
 * Base64-encodes a string identically in Node 20+ and browsers (no Buffer).
 *
 * @param {string} content
 * @returns {string}
 */
function toBase64(content) {
  return btoa(unescape(encodeURIComponent(content)));
}

/**
 * Resolves a relative ref against basePath's directory into a workspace-
 * normalized path.
 *
 * @param {string} ref
 * @param {string} basePath
 * @returns {string}
 */
function resolveRelative(ref, basePath) {
  const dir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  const combined = dir ? `${dir}/${ref}` : ref;

  const segments = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return normalizePath(segments.join("/"));
}

// Matches href/src attributes on link/script/img tags, capturing the tag
// name and the quoted attribute value.
const REF_RE = /<(link|script|img)\b([^>]*?)\s(href|src)=(["'])(.*?)\4([^>]*)>/gi;

/**
 * Returns true if a ref should be left untouched (external, already a data:
 * or blob: URI, an anchor, or a mailto: link).
 *
 * @param {string} ref
 * @returns {boolean}
 */
function isUntouchable(ref) {
  return /^(https?:)?\/\//i.test(ref) || /^(data|blob|mailto):/i.test(ref) || ref.startsWith("#") || ref === "";
}

/**
 * Rewrites relative `<link|script|img>` href/src refs in `html` to `data:`
 * URIs resolved against the virtual filesystem, so the result is safe to use
 * as an iframe's srcDoc with no further network access. External refs,
 * data:/blob:/mailto: URIs, anchors, and refs that don't resolve to a known
 * file are left untouched (graceful degrade).
 *
 * `transformContent`, when given, is applied to each resolved file's content
 * before base64 encoding (used for render-time {{userName}} interpolation —
 * inlined files are markup sinks, so callers pass an HTML-escaping transform).
 *
 * @param {string} html
 * @param {import("./virtualFs.js").VFiles} files
 * @param {string} basePath
 * @param {(content: string) => string} [transformContent]
 * @returns {string}
 */
export function rewriteRefs(html, files, basePath, transformContent) {
  return html.replace(REF_RE, (match, tag, pre, attr, quote, ref, post) => {
    // Defense-in-depth for future untrusted (BYOK) content: strip executable
    // URL schemes rather than passing them through. Harmless today (the
    // sandbox already permits scripts) but load-bearing if it's ever weakened.
    if (/^\s*(javascript|vbscript)\s*:/i.test(ref)) {
      return `<${tag}${pre} ${attr}=${quote}about:blank${quote}${post}>`;
    }
    if (isUntouchable(ref)) return match;

    const resolved = resolveRelative(ref, basePath);
    const file = getFile(files, resolved);
    if (!file) return match;

    const content = transformContent ? transformContent(file.content) : file.content;
    const dataUri = `data:${mimeFor(resolved)};base64,${toBase64(content)}`;
    return `<${tag}${pre} ${attr}=${quote}${dataUri}${quote}${post}>`;
  });
}
