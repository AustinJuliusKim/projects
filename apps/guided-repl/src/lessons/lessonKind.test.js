import { test } from "node:test";
import assert from "node:assert";
import { lessonKind } from "./lessonKind.js";

test("lessonKind: quiz assertion → quiz kind with ? glyph", () => {
  const result = lessonKind({ type: "quiz", question: "Which step?" });
  assert.equal(result.kind, "quiz");
  assert.equal(result.glyph, "?");
  assert.equal(result.label, "Quiz");
});

test("lessonKind: file-contains assertion → check kind with ✓ glyph", () => {
  const result = lessonKind({ type: "file-contains", path: "index.html", match: "<h1>" });
  assert.equal(result.kind, "check");
  assert.equal(result.glyph, "✓");
  assert.equal(result.label, "Check");
});

test("lessonKind: undefined assertion → check kind (default)", () => {
  const result = lessonKind(undefined);
  assert.equal(result.kind, "check");
  assert.equal(result.glyph, "✓");
  assert.equal(result.label, "Check");
});
