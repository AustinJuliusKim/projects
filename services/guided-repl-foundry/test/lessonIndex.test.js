import test from "node:test";
import assert from "node:assert/strict";

import { buildLessonIndex, gateTopic, tokenize } from "../src/overlap/lessonIndex.js";
import { loadConfig } from "../src/config.js";

const { settings } = loadConfig();
const index = buildLessonIndex();

test("index covers the real committed l1–l8 corpus", () => {
  const ids = index.lessons.map((l) => l.id);
  assert.ok(ids.includes("l1") && ids.includes("l8"), `got ${ids.join(",")}`);
  assert.ok(index.lessons.length >= 8);
});

test("near-duplicate topic gates out against the real corpus", () => {
  const verdict = gateTopic(index, "ship a landing page with Claude Code", settings.overlapThreshold);
  assert.equal(verdict.passed, false, `expected gate-out, score=${verdict.score}`);
  assert.equal(verdict.nearestLessonId, "l1");
  assert.match(verdict.reason, /overlap/);
});

test("genuinely novel topic passes the gate", () => {
  const verdict = gateTopic(index, "evaluating RAG retrieval quality", settings.overlapThreshold);
  assert.equal(verdict.passed, true, `expected pass, score=${verdict.score} vs ${verdict.nearestLessonId}`);
  assert.ok(verdict.score < settings.overlapThreshold);
});

test("scores are in [0,1]; empty topic scores 0", () => {
  for (const topic of ["plan mode", "make a page about me", "quantum knitting for llamas", ""]) {
    const { score } = index.overlapScore(topic);
    assert.ok(score >= 0 && score <= 1, `${topic}: ${score}`);
  }
  assert.deepEqual(index.overlapScore(""), { score: 0, nearestLessonId: null });
});

test("nearest lesson id answers \"which lesson covers X\"", () => {
  const { nearestLessonId } = index.overlapScore("permission modes acceptEdits bypass plan");
  assert.ok(typeof nearestLessonId === "string" && nearestLessonId.startsWith("l"));
});

test("tokenize drops stopwords and short tokens", () => {
  assert.deepEqual(tokenize("Ship a page in 90 seconds!"), ["ship", "page", "90", "seconds"]);
});
