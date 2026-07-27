#!/usr/bin/env node
// Turns content/posts/*.md into src/generated/posts.json.
//
// Everything here runs in Node at build time, so marked/shiki/gray-matter stay
// devDependencies and never reach the browser bundle. The site keeps its three
// runtime dependencies.
//
// Run by `npm run build` before tsc, because src/generated/posts.json is a
// typechecked import.

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { Marked } from "marked";
import { codeToHtml, bundledLanguages } from "shiki";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = join(root, "content", "posts");
const OUT_FILE = join(root, "src", "generated", "posts.json");

const REQUIRED = ["title", "date", "description"];

// Dual themes so code follows the site's prefers-color-scheme dark mode.
// defaultColor:false emits --shiki-dark custom properties for blog.css to use.
async function highlight(code, lang) {
  const language = lang && lang in bundledLanguages ? lang : "text";
  return codeToHtml(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}

const marked = new Marked({
  async: true,
  gfm: true,
  async walkTokens(token) {
    if (token.type === "code") {
      token.text = await highlight(token.text, token.lang);
      token.escaped = true; // already safe HTML from shiki
    }
  },
  renderer: {
    code({ text, escaped }) {
      return escaped ? text : `<pre><code>${text}</code></pre>\n`;
    },
  },
});

// YAML parses an unquoted 2026-07-26 into a Date at UTC midnight, while a
// quoted "2026-07-26" stays a string. Normalise both to a UTC date string —
// reading the Date in local time would render the previous day west of UTC.
function normaliseDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function displayDate(iso) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

async function main() {
  if (!existsSync(POSTS_DIR)) {
    console.warn(`build-posts: no ${POSTS_DIR}, writing an empty index.`);
    await writeIndex([]);
    return;
  }

  const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md"));
  const posts = [];

  for (const file of files) {
    const slug = basename(file, ".md");
    const raw = await readFile(join(POSTS_DIR, file), "utf8");
    const { data, content } = matter(raw);

    // Fail loudly. A post that silently ships without a title or description
    // gets an empty <title> and a blank link preview, which is worse than a
    // broken build.
    const missing = REQUIRED.filter((k) => !data[k]);
    if (missing.length) {
      throw new Error(`${file}: missing frontmatter ${missing.join(", ")}`);
    }
    const date = normaliseDate(data.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`${file}: date must be YYYY-MM-DD, got "${data.date}"`);
    }
    if (data.draft === true) {
      console.log(`build-posts: skipping draft ${slug}`);
      continue;
    }

    posts.push({
      slug,
      title: String(data.title),
      date,
      dateDisplay: displayDate(date),
      description: String(data.description),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      html: await marked.parse(content),
    });
  }

  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  await writeIndex(posts);
  console.log(`build-posts: wrote ${posts.length} post(s).`);
}

async function writeIndex(posts) {
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(posts, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`build-posts failed: ${err.message}`);
  process.exit(1);
});
