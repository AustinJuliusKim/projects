import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fetchSource, fetchRss, fetchHtmlList } from "../src/sources/fetchers.js";
import { createFakeFetch } from "./fakes/fakeFetch.js";

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

test("githubReleases normalizes tag/name/body", async () => {
  const { fetchImpl, requests } = createFakeFetch({
    "https://api.github.com/repos/anthropics/claude-code/releases": JSON.parse(fixture("github-releases.json")),
  });
  const items = await fetchSource(
    { id: "claude-code-releases", method: "githubReleases", repo: "anthropics/claude-code" },
    { fetchImpl },
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "v2.5.0");
  assert.equal(items[0].title, "Claude Code v2.5.0");
  assert.match(items[0].body, /goal command/);
  assert.match(requests[0].headers.accept, /github/);
  assert.equal(requests[0].headers.authorization, undefined, "no token header by default");
});

test("githubCommits uses first message line as title and passes optional token", async () => {
  const { fetchImpl, requests } = createFakeFetch({
    "https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/commits": JSON.parse(fixture("github-commits.json")),
  });
  const items = await fetchSource(
    { id: "mcp-spec", method: "githubCommits", repo: "modelcontextprotocol/modelcontextprotocol" },
    { fetchImpl, githubToken: "ghp_test" },
  );
  assert.equal(items[0].title, "spec: add streamable HTTP transport resumability");
  assert.equal(items[0].id.length, 40);
  assert.equal(requests[0].headers.authorization, "Bearer ghp_test");
});

test("rss parses items, CDATA, entities, and guids", async () => {
  const { fetchImpl } = createFakeFetch({ "https://huggingface.co/blog/feed.xml": fixture("hf-blog.rss.xml") });
  const items = await fetchRss({ url: "https://huggingface.co/blog/feed.xml", fetchImpl });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Evaluating RAG pipelines with open judges");
  assert.equal(items[0].id, "hf-blog-rag-eval");
  assert.equal(items[0].url, "https://huggingface.co/blog/rag-eval-open-judges");
  assert.match(items[0].body, /retrieval quality & faithfulness/);
});

test("htmlList extracts catalog anchors, absolutizes, skips nav chrome and dupes", async () => {
  const { fetchImpl } = createFakeFetch({ "https://www.anthropic.com/learn": fixture("academy.html") });
  const items = await fetchHtmlList({ url: "https://www.anthropic.com/learn", fetchImpl });
  const titles = items.map((i) => i.title);
  assert.deepEqual(titles, [
    "Build with the Claude API",
    "Building agents with MCP",
    "Prompting fundamentals for developers",
  ]);
  assert.equal(items[0].url, "https://www.anthropic.com/learn/build-with-claude-api");
});

test("HTTP failures throw with status (per-source isolation happens in the scout)", async () => {
  const { fetchImpl } = createFakeFetch({ "https://api.github.com/": { status: 503, body: "down" } });
  await assert.rejects(
    fetchSource({ id: "x", method: "githubReleases", repo: "a/b" }, { fetchImpl }),
    /HTTP 503/,
  );
});
