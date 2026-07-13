import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { lintLessonDoc, llmLint, MAX_RUN_BRANCHES } from "../src/lint/lessonLint.js";
import { createAgentClient } from "../src/agent/agentClient.js";
import { loadConfig } from "../src/config.js";
import { createFakeAgent } from "./fakes/fakeAgent.js";

const { models, settings } = loadConfig();
const draft = () =>
  parseYaml(readFileSync(fileURLToPath(new URL("./fixtures/valid-draft.yaml", import.meta.url)), "utf8"));

test("the valid draft fixture lints clean", () => {
  const result = lintLessonDoc(draft());
  assert.deepEqual(result, { ok: true, failures: [] });
});

test("duration cap is a hard failure with a precise message", () => {
  const doc = { ...draft(), durationTargetSec: 331 };
  const { ok, failures } = lintLessonDoc(doc);
  assert.equal(ok, false);
  assert.equal(failures[0].rule, "duration-cap");
  assert.match(failures[0].message, /331 exceeds the 5-minute cap \(330s\)/);
});

test("run branch cap", () => {
  const doc = draft();
  const run = doc.steps.find((s) => s.type === "run");
  for (let i = 0; i <= MAX_RUN_BRANCHES; i++) {
    run.branches[`extra${i}`] = { fixture: "measure", expectedPrompt: `p${i}`, permissionMode: "acceptEdits" };
  }
  const { failures } = lintLessonDoc(doc);
  assert.ok(failures.some((f) => f.rule === "branch-cap" && /max 3/.test(f.message)));
});

test("exactly one assertion step", () => {
  const doc = draft();
  doc.steps = doc.steps.filter((s) => s.type !== "assertion");
  assert.ok(lintLessonDoc(doc).failures.some((f) => f.rule === "single-assertion" && /found 0/.test(f.message)));

  const two = draft();
  two.steps.push({ type: "assertion", id: "grade2", rule: { type: "file-exists", path: "x" } });
  assert.ok(lintLessonDoc(two).failures.some((f) => f.rule === "single-assertion" && /found 2/.test(f.message)));
});

test("completion refs must include the assertion step", () => {
  const doc = draft();
  doc.completion.assertionIds = ["quiz"];
  const { failures } = lintLessonDoc(doc);
  assert.ok(failures.some((f) => f.rule === "completion-refs" && /must include the assertion step "grade"/.test(f.message)));

  const unknown = draft();
  unknown.completion.assertionIds = ["grade", "ghost"];
  assert.ok(lintLessonDoc(unknown).failures.some((f) => /unknown step "ghost"/.test(f.message)));
});

test("v1 draft constraints: snapshot, track, permission modes", () => {
  const doc = draft();
  doc.snapshot.snapshotId = "l8-output";
  doc.track = "guided";
  doc.steps.find((s) => s.type === "run").branches.measure.permissionMode = "bypassPermissions";
  const { failures } = lintLessonDoc(doc);
  const rules = failures.map((f) => f.rule);
  assert.ok(rules.includes("draft-snapshot"));
  assert.ok(rules.includes("draft-track"));
  assert.ok(rules.includes("draft-permission-mode"));

  // ...and can be relaxed for non-draft (human-authored) docs.
  const relaxed = lintLessonDoc(doc, { draftConstraints: false });
  assert.ok(!relaxed.failures.some((f) => f.rule.startsWith("draft-")));
});

test("llmLint is advisory: returns linter-role notes and cost", async () => {
  const fake = createFakeAgent({ responses: ["- tighten the quiz distractors\n- LGTM otherwise"] });
  const client = createAgentClient({ queryImpl: fake.queryImpl, models, pricing: settings.pricing });
  const { notes, model, costUsd } = await llmLint({ agentClient: client, yamlText: "id: l9" });
  assert.match(notes, /quiz distractors/);
  assert.equal(model, "claude-sonnet-4-6");
  assert.ok(costUsd > 0);
  assert.equal(fake.calls[0].role, "linter");
});
