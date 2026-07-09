import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonKind } from "./lessonKind.js";

test("lessonKind: quiz step → quiz kind with ? glyph", () => {
  const steps = [
    { type: "instruction", id: "intro", md: "x" },
    { type: "quiz", id: "quiz", question: "?", options: ["a", "b"], answerIdx: 0 },
  ];
  assert.deepEqual(lessonKind(steps), { kind: "quiz", label: "Quiz", glyph: "?" });
});

test("lessonKind: assertion-only steps → check kind with ✓ glyph", () => {
  const steps = [{ type: "assertion", id: "grade", rule: { type: "file-exists", path: "index.html" } }];
  assert.deepEqual(lessonKind(steps), { kind: "check", label: "Check", glyph: "✓" });
});

test("lessonKind: undefined steps → check kind", () => {
  assert.deepEqual(lessonKind(undefined), { kind: "check", label: "Check", glyph: "✓" });
});
