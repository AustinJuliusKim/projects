import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToolUse, mergeTree, buildTree, getFile, normalizePath } from "./virtualFs.js";

test("normalizePath strips leading ./ and /", () => {
  assert.equal(normalizePath("./index.html"), "index.html");
  assert.equal(normalizePath("/index.html"), "index.html");
  assert.equal(normalizePath("index.html"), "index.html");
});

test("applyToolUse Write creates a file and tracks prevContent", () => {
  const files = applyToolUse({}, "Write", { file_path: "./index.html", content: "<h1>hi</h1>" });
  assert.equal(files["index.html"].content, "<h1>hi</h1>");
  assert.equal(files["index.html"].prevContent, null);

  const files2 = applyToolUse(files, "Write", { file_path: "index.html", content: "<h1>bye</h1>" });
  assert.equal(files2["index.html"].content, "<h1>bye</h1>");
  assert.equal(files2["index.html"].prevContent, "<h1>hi</h1>");
});

test("applyToolUse Edit replaces old_string with new_string", () => {
  const seed = { "index.html": { content: "<h1>hi</h1>", prevContent: undefined } };
  const files = applyToolUse(seed, "Edit", {
    file_path: "index.html",
    old_string: "hi",
    new_string: "world",
  });
  assert.equal(files["index.html"].content, "<h1>world</h1>");
  assert.equal(files["index.html"].prevContent, "<h1>hi</h1>");
});

test("applyToolUse MultiEdit applies edits sequentially", () => {
  const seed = { "a.txt": { content: "one two three", prevContent: undefined } };
  const files = applyToolUse(seed, "MultiEdit", {
    file_path: "a.txt",
    edits: [
      { old_string: "one", new_string: "1" },
      { old_string: "three", new_string: "3" },
    ],
  });
  assert.equal(files["a.txt"].content, "1 two 3");
  assert.equal(files["a.txt"].prevContent, "one two three");
});

test("mergeTree seeds empty entries for new file paths, leaves existing content alone", () => {
  const seed = { "index.html": { content: "<h1>hi</h1>", prevContent: undefined } };
  const merged = mergeTree(seed, {
    tree: [
      { path: "index.html", type: "file" },
      { path: "README.md", type: "file" },
      { path: "src", type: "dir" },
    ],
  });
  assert.equal(merged["index.html"].content, "<h1>hi</h1>");
  assert.equal(merged["README.md"].content, "");
  assert.equal(merged["src"], undefined);
});

test("getFile returns the entry for a normalized path", () => {
  const files = { "a.txt": { content: "x", prevContent: undefined } };
  assert.equal(getFile(files, "./a.txt").content, "x");
  assert.equal(getFile(files, "b.txt"), undefined);
});

test("buildTree converts flat files into a nested tree", () => {
  const files = {
    "index.html": { content: "", prevContent: undefined },
    "src/app.js": { content: "", prevContent: undefined },
  };
  const tree = buildTree(files);
  const names = tree.map((n) => n.name).sort();
  assert.deepEqual(names, ["index.html", "src"]);

  const srcDir = tree.find((n) => n.name === "src");
  assert.equal(srcDir.type, "dir");
  assert.equal(srcDir.children[0].name, "app.js");
  assert.equal(srcDir.children[0].path, "src/app.js");
});
