import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./assertionEvaluator.js";

const files = { "index.html": { content: "<html><h1>Hi</h1></html>" } };
const messages = [
  { role: "user", text: "make a page about me" },
  { role: "assistant", text: "Sure, creating the page." },
  { role: "tool", tool: "Write", input: {}, result: { content: "File written successfully.", isError: false } },
];

test("file-contains passes when the file includes the match", () => {
  const result = evaluate({ type: "file-contains", path: "index.html", match: "<h1>" }, { files, messages });
  assert.equal(result.pass, true);
});

test("file-contains fails when the file lacks the match", () => {
  const result = evaluate({ type: "file-contains", path: "index.html", match: "<p>" }, { files, messages });
  assert.equal(result.pass, false);
});

test("file-contains fails when the file was never created", () => {
  const result = evaluate({ type: "file-contains", path: "missing.html", match: "<h1>" }, { files, messages });
  assert.equal(result.pass, false);
});

test("file-exists passes when the file is present", () => {
  const result = evaluate({ type: "file-exists", path: "index.html" }, { files, messages });
  assert.equal(result.pass, true);
});

test("file-exists fails when the file is absent", () => {
  const result = evaluate({ type: "file-exists", path: "missing.html" }, { files, messages });
  assert.equal(result.pass, false);
});

test("terminal-matches passes when any message content matches", () => {
  const result = evaluate({ type: "terminal-matches", match: "written successfully" }, { files, messages });
  assert.equal(result.pass, true);
});

test("terminal-matches fails when no message content matches", () => {
  const result = evaluate({ type: "terminal-matches", match: "nope" }, { files, messages });
  assert.equal(result.pass, false);
});

test("file-equals passes when content matches exactly", () => {
  const result = evaluate(
    { type: "file-equals", path: "index.html", content: "<html><h1>Hi</h1></html>" },
    { files, messages }
  );
  assert.equal(result.pass, true);
});

test("file-equals fails when content differs", () => {
  const result = evaluate(
    { type: "file-equals", path: "index.html", content: "different" },
    { files, messages }
  );
  assert.equal(result.pass, false);
});

const quiz = { type: "quiz", question: "Which step ran first?", choices: ["Explore", "Plan"], correctIndex: 0 };

test("quiz fails with a prompt to answer when no quizAnswer is given", () => {
  const result = evaluate(quiz, { files, messages });
  assert.equal(result.pass, false);
  assert.equal(result.detail, "Select an answer to continue");
});

test("quiz passes when quizAnswer matches correctIndex", () => {
  const result = evaluate(quiz, { files, messages, quizAnswer: 0 });
  assert.equal(result.pass, true);
});

test("quiz fails when quizAnswer does not match correctIndex", () => {
  const result = evaluate(quiz, { files, messages, quizAnswer: 1 });
  assert.equal(result.pass, false);
});
