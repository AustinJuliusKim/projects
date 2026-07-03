import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownDoc } from "./markdownPreview.js";

test("renderMarkdownDoc renders a heading into an <h1>", () => {
  const out = renderMarkdownDoc("# My Page\n\nStarter workspace.");
  assert.match(out, /<h1>My Page<\/h1>/);
});

test("renderMarkdownDoc wraps output in a full HTML document", () => {
  const out = renderMarkdownDoc("hello");
  assert.match(out, /^<!DOCTYPE html>/);
  assert.match(out, /<html>/);
  assert.match(out, /<body>/);
});

test("renderMarkdownDoc embeds theme CSS inline (no external stylesheet)", () => {
  const out = renderMarkdownDoc("hello");
  assert.match(out, /<style>[\s\S]*background: #0c0c0d[\s\S]*<\/style>/);
});
