/**
 * Source fetchers: normalize every registry method to a common item shape
 * {id, title, url, date, body}. All network goes through an injected
 * fetch-compatible `fetchImpl`; tests pass recorded payloads and CI stays
 * keyless. GitHub uses the public REST API — no auth required at our
 * volumes; an optional GITHUB_TOKEN adds rate headroom.
 */

/**
 * @typedef {object} SourceItem
 * @property {string} id stable identifier within the source (tag, sha, guid, href)
 * @property {string} title
 * @property {string} url
 * @property {string} [date] ISO-ish date string when the source provides one
 * @property {string} [body] excerpt/body text for the scout prompt
 */

const MAX_BODY_CHARS = 2000;

/** @param {string|undefined} s */
function clip(s) {
  if (!s) return undefined;
  const trimmed = s.trim();
  return trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {Record<string, string>} headers
 */
async function getOk(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  return res;
}

/** @param {string|undefined} token */
function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "guided-repl-foundry",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * @param {{repo: string, fetchImpl: typeof fetch, githubToken?: string}} opts
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchGithubReleases({ repo, fetchImpl, githubToken }) {
  const res = await getOk(fetchImpl, `https://api.github.com/repos/${repo}/releases?per_page=20`, githubHeaders(githubToken));
  const releases = await res.json();
  return releases.map((r) => ({
    id: r.tag_name ?? String(r.id),
    title: r.name || r.tag_name || "(untitled release)",
    url: r.html_url,
    date: r.published_at,
    body: clip(r.body),
  }));
}

/**
 * @param {{repo: string, fetchImpl: typeof fetch, githubToken?: string}} opts
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchGithubCommits({ repo, fetchImpl, githubToken }) {
  const res = await getOk(fetchImpl, `https://api.github.com/repos/${repo}/commits?per_page=30`, githubHeaders(githubToken));
  const commits = await res.json();
  return commits.map((c) => ({
    id: c.sha,
    title: (c.commit?.message ?? "").split("\n")[0] || c.sha,
    url: c.html_url,
    date: c.commit?.author?.date,
    body: clip(c.commit?.message),
  }));
}

/** Minimal tag-content extractor for the RSS/Atom shapes we consume. */
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return undefined;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * RSS 2.0 <item> or Atom <entry>, parsed scrape-lite (feeds are structured
 * enough that a dependency-free extractor is fine at our volumes).
 *
 * @param {{url: string, fetchImpl: typeof fetch}} opts
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchRss({ url, fetchImpl }) {
  const res = await getOk(fetchImpl, url, { "user-agent": "guided-repl-foundry" });
  const xml = await res.text();
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocks.map((block, i) => {
    const title = tagText(block, "title") ?? `(untitled ${i})`;
    // Atom links live in href attributes; RSS links are tag content.
    const atomHref = block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const link = atomHref ?? tagText(block, "link") ?? url;
    return {
      id: tagText(block, "guid") ?? tagText(block, "id") ?? link,
      title,
      url: link,
      date: tagText(block, "pubDate") ?? tagText(block, "updated") ?? tagText(block, "published"),
      body: clip(tagText(block, "description") ?? tagText(block, "summary") ?? tagText(block, "content")),
    };
  });
}

/**
 * Scrape-lite catalog page fetcher (the registry's one exception to "feeds
 * and git over scraping"): anchors with meaningful text become items.
 *
 * @param {{url: string, fetchImpl: typeof fetch}} opts
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchHtmlList({ url, fetchImpl }) {
  const res = await getOk(fetchImpl, url, { "user-agent": "guided-repl-foundry" });
  const html = await res.text();
  const items = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\s[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length < 8 || seen.has(href)) continue; // skip nav chrome/dupes
    seen.add(href);
    const abs = new URL(href, url).toString();
    items.push({ id: abs, title: text, url: abs });
  }
  return items;
}

/**
 * Dispatches one registry source to its fetcher.
 *
 * @param {{id: string, method: string, repo?: string, url?: string}} source
 * @param {{fetchImpl: typeof fetch, githubToken?: string}} deps
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchSource(source, { fetchImpl, githubToken }) {
  switch (source.method) {
    case "githubReleases":
      return fetchGithubReleases({ repo: source.repo, fetchImpl, githubToken });
    case "githubCommits":
      return fetchGithubCommits({ repo: source.repo, fetchImpl, githubToken });
    case "rss":
      return fetchRss({ url: source.url, fetchImpl });
    case "htmlList":
      return fetchHtmlList({ url: source.url, fetchImpl });
    default:
      throw new Error(`Unknown source method "${source.method}" for ${source.id}`);
  }
}
