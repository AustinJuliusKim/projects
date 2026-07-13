import { test } from "node:test";
import assert from "node:assert/strict";
import { fileKind, rewriteRefs } from "./previewRefs.js";

test("fileKind maps extensions to preview kinds", () => {
  assert.equal(fileKind("index.html"), "html");
  assert.equal(fileKind("page.htm"), "html");
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("notes.markdown"), "markdown");
  assert.equal(fileKind("app.js"), "js");
  assert.equal(fileKind("app.jsx"), "js");
  assert.equal(fileKind("data.json"), null);
});

test("rewriteRefs rewrites a same-dir ref to a base64 data: URI that round-trips", () => {
  const files = {
    "index.html": { content: '<link rel="stylesheet" href="style.css">', prevContent: undefined },
    "style.css": { content: "body { color: red; }", prevContent: undefined },
  };
  const out = rewriteRefs(files["index.html"].content, files, "index.html");
  const match = out.match(/href="data:text\/css;base64,([^"]+)"/);
  assert.ok(match, `expected a data: URI, got: ${out}`);
  const decoded = decodeURIComponent(escape(atob(match[1])));
  assert.equal(decoded, "body { color: red; }");
});

test("rewriteRefs leaves external refs untouched", () => {
  const files = { "index.html": { content: "", prevContent: undefined } };
  const html = '<script src="https://cdn.example.com/lib.js"></script><img src="//example.com/a.png">';
  assert.equal(rewriteRefs(html, files, "index.html"), html);
});

test("rewriteRefs leaves unresolved refs untouched", () => {
  const files = { "index.html": { content: "", prevContent: undefined } };
  const html = '<img src="missing.png">';
  assert.equal(rewriteRefs(html, files, "index.html"), html);
});

test("rewriteRefs resolves refs relative to a subdirectory basePath", () => {
  const files = {
    "pages/index.html": { content: '<script src="../shared/app.js"></script>', prevContent: undefined },
    "shared/app.js": { content: "console.log('hi');", prevContent: undefined },
  };
  const out = rewriteRefs(files["pages/index.html"].content, files, "pages/index.html");
  const match = out.match(/src="data:text\/javascript;base64,([^"]+)"/);
  assert.ok(match, `expected a data: URI, got: ${out}`);
  const decoded = decodeURIComponent(escape(atob(match[1])));
  assert.equal(decoded, "console.log('hi');");
});

test("rewriteRefs strips executable url schemes to about:blank", () => {
  const files = {};
  const html = `<script src="javascript:alert(1)"></script><img src=" VBScript:x">`;
  const out = rewriteRefs(html, files, "index.html");
  assert.ok(!/javascript:/i.test(out));
  assert.ok(!/vbscript:/i.test(out));
  assert.ok(out.includes("about:blank"));
});

test("rewriteRefs applies transformContent to inlined file content before encoding", () => {
  const files = {
    "index.html": { content: '<link href="style.css">', prevContent: undefined },
    "style.css": { content: "h1::after { content: '{{userName}}'; }", prevContent: undefined },
  };
  const out = rewriteRefs(files["index.html"].content, files, "index.html", (c) =>
    c.replaceAll("{{userName}}", "Ada"),
  );
  const match = out.match(/href="data:text\/css;base64,([^"]+)"/);
  assert.ok(match, `expected a data: URI, got: ${out}`);
  const decoded = decodeURIComponent(escape(atob(match[1])));
  assert.equal(decoded, "h1::after { content: 'Ada'; }");
});
