#!/usr/bin/env node
/**
 * Verifies every active lesson's branch expectedPrompt is reproducible via
 * the join rule task + " " + subject + (", " + constraint)? from that
 * lesson's promptChoices arrays (constraint === "" means omitted).
 *
 * Usage: node scripts/checkPromptJoin.js
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const fixtureVersion = process.env.VITE_FIXTURE_VERSION || "v1";
const lessonsPath = join(appRoot, "public", "fixtures", fixtureVersion, "lessons.json");

const lessonsDoc = JSON.parse(readFileSync(lessonsPath, "utf8"));
const errors = [];

function join_(task, subject, constraint) {
  const base = `${task} ${subject}`;
  return constraint ? `${base}, ${constraint}` : base;
}

for (const lesson of lessonsDoc.lessons) {
  if (lesson.locked || !lesson.promptChoices || !lesson.branchConfig) continue;
  const { task = [], subject = [], constraint = [] } = lesson.promptChoices;

  for (const branchId of lesson.branches ?? []) {
    const cfg = lesson.branchConfig[branchId];
    if (!cfg) continue;
    const found = task.some((t) => subject.some((s) => constraint.some((c) => join_(t, s, c) === cfg.expectedPrompt)));
    if (!found) {
      errors.push(
        `${lesson.lessonId}/${branchId}: expectedPrompt ${JSON.stringify(cfg.expectedPrompt)} is not reproducible via task+" "+subject+(", "+constraint)? from promptChoices`
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`checkPromptJoin: ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("checkPromptJoin: OK — every branch expectedPrompt reproducible via the join rule.");
