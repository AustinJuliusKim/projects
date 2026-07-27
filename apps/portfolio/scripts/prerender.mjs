#!/usr/bin/env node
// Post-build: write a real HTML file per blog page, plus rss.xml.
//
// Why this exists: the site is a client-rendered SPA, so every route otherwise
// shares one <title> and one description, and a shared link renders a blank
// card. This injects per-page metadata and the post body into the built shell.
//
// This is prerendering for crawlers and unfurlers, not hydration — React's
// createRoot().render() replaces the markup on load. The point is that the
// content and metadata exist in the HTML for clients that never run JS.
//
// Serving depends on the CloudFront viewer-request function rewriting
// /blog/<slug> to /blog/<slug>/index.html; S3 is a REST origin and will not
// resolve directory indexes itself.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(root, "dist");
const POSTS = JSON.parse(
  await readFile(join(root, "src", "generated", "posts.json"), "utf8")
);

const SITE = "https://austinjuliuskim.com";
const AUTHOR = "Austin Kim";
const BLOG_TITLE = "Notes on building — Austin Kim";
const BLOG_DESC =
  "Working notes on AI-native tooling — what I built, what it measured, and what broke.";

const START = "<!--HEAD_META_START-->";
const END = "<!--HEAD_META_END-->";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function head({ title, description, url, type = "website", published }) {
  return [
    `<meta name="description" content="${esc(description)}" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:site_name" content="${esc(AUTHOR)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    published
      ? `<meta property="article:published_time" content="${esc(published)}" />`
      : "",
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<title>${esc(title)}</title>`,
  ]
    .filter(Boolean)
    .join("\n    ");
}

function render(shell, meta, bodyHtml) {
  const a = shell.indexOf(START);
  const b = shell.indexOf(END);
  if (a === -1 || b === -1) {
    throw new Error(
      "index.html is missing the HEAD_META markers; prerender cannot inject metadata"
    );
  }
  const withHead =
    shell.slice(0, a + START.length) + "\n    " + head(meta) + "\n    " + shell.slice(b);

  // Seed #root so the content is in the HTML for clients that never run JS.
  return withHead.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);
}

async function write(relPath, html) {
  const out = join(DIST, relPath, "index.html");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html);
  console.log(`prerender: ${relPath || "/"}/index.html`);
}

function rss(posts) {
  const items = posts
    .map((p) => {
      const url = `${SITE}/blog/${p.slug}`;
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(BLOG_TITLE)}</title>
    <link>${SITE}/blog</link>
    <description>${esc(BLOG_DESC)}</description>
    <language>en</language>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

const shell = await readFile(join(DIST, "index.html"), "utf8");

// Blog index
const list = POSTS.map(
  (p) =>
    `<article><h2><a href="/blog/${p.slug}">${esc(p.title)}</a></h2>` +
    `<p><time datetime="${p.date}">${esc(p.dateDisplay)}</time></p>` +
    `<p>${esc(p.description)}</p></article>`
).join("");

await write(
  "blog",
  render(
    shell,
    { title: BLOG_TITLE, description: BLOG_DESC, url: `${SITE}/blog` },
    `<h1>${esc(BLOG_TITLE)}</h1>${list}`
  )
);

// One directory per post
for (const p of POSTS) {
  await write(
    `blog/${p.slug}`,
    render(
      shell,
      {
        title: `${p.title} — ${AUTHOR}`,
        description: p.description,
        url: `${SITE}/blog/${p.slug}`,
        type: "article",
        published: p.date,
      },
      `<article><h1>${esc(p.title)}</h1>` +
        `<p><time datetime="${p.date}">${esc(p.dateDisplay)}</time></p>` +
        `${p.html}</article>`
    )
  );
}

await writeFile(join(DIST, "rss.xml"), rss(POSTS));
console.log(`prerender: rss.xml (${POSTS.length} item(s))`);
