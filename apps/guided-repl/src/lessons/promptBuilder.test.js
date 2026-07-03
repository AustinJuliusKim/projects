import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "./promptBuilder.js";

const lessonsPath = fileURLToPath(new URL("../../public/fixtures/v1/lessons.json", import.meta.url));
const lessonsJson = JSON.parse(readFileSync(lessonsPath, "utf8"));
const branchConfig = lessonsJson.lessons[0].branchConfig;

test("buildPrompt joins task and subject with a space, no constraint", () => {
  assert.equal(buildPrompt({ task: "make a page", subject: "about me", constraint: "" }), "make a page about me");
});

test("buildPrompt appends the constraint after a comma", () => {
  assert.equal(
    buildPrompt({ task: "make a page", subject: "about me", constraint: "in index.html" }),
    "make a page about me, in index.html"
  );
});

test("buildPrompt reproduces the vague branch's expectedPrompt", () => {
  assert.equal(
    buildPrompt({ task: "make a page", subject: "about me", constraint: "in index.html" }),
    branchConfig.vague.expectedPrompt
  );
});

test("buildPrompt reproduces the constrained branch's expectedPrompt", () => {
  assert.equal(
    buildPrompt({ task: "make a personal landing page", subject: "about me", constraint: "single index.html file, inline CSS" }),
    branchConfig.constrained.expectedPrompt
  );
});

test("buildPrompt reproduces the plan-mode branch's expectedPrompt", () => {
  assert.equal(
    buildPrompt({ task: "make a personal landing page", subject: "for my photography", constraint: "single index.html file, inline CSS" }),
    branchConfig["plan-mode"].expectedPrompt
  );
});
