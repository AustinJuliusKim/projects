/**
 * One-shot converter: legacy lessons.json manifest → per-lesson YAML sources
 * in the Lesson Engine schema. Kept in-repo for provenance; the committed
 * YAML output is the source of truth afterwards (hand-polish prose there,
 * not here).
 *
 * CLI: node src/convertLegacy.js [path/to/legacy/lessons.json] [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { LESSON_SCHEMA_VERSION } from "@guided-repl/protocol";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEGACY = resolve(PKG_ROOT, "../../apps/guided-repl/public/fixtures/v1/lessons.json");
const DEFAULT_OUT_DIR = join(PKG_ROOT, "lessons");

/** Rail copy per lesson — seeded from the Lesson Plan spine, hand-polishable in the YAML. */
const INSTRUCTION_MD = {
  l1: "**Ship a page in 90 seconds.** Pick a prompt below and run it — you'll watch Claude Code explore the workspace, plan, edit files, and verify, ending with a live personal page in the preview pane.",
  l2: "**Why did it do that?** This replays Lesson 1's run one beat at a time. At each pause, read the annotation: which tool ran, why, and what entered the context window.",
  l3: "**The prompt ladder.** Restyle the page three ways — vague, constrained, and planned. Run each branch and compare the diffs: more specific prompts produce more controlled outcomes.",
  l4: "**Plan mode.** Ask for a plan before any file changes. You can approve it as-is, or revise it first and watch execution follow the revised plan.",
  l5: "**Permission modes are the leash.** Run the same change in plan, acceptEdits, and bypassPermissions modes. Notice where each mode pauses for your review — and where it doesn't.",
  l6: "**Review before you accept.** Two runs add a testimonials section; one plants a bug. Read the diffs in the workspace pane and catch it before it ships.",
  l7: "**Teach your agent.** The same prompt, with and without a CLAUDE.md conventions file in the workspace. Watch how the conventions change what Claude writes.",
  l8: "**Cost & models.** Run the same small tweak on Haiku and on Sonnet with the token meter on, and decide which model this task actually needs.",
};

/** Composer dropdown descriptions per branch — what makes this branch different. */
const BRANCH_DESCRIPTIONS = {
  l1: { vague: "the vague prompt", constrained: "a constrained prompt", "plan-mode": "constrained, in plan mode" },
  l2: { walkthrough: "replay Lesson 1's run step by step" },
  l3: { vague: "the vague restyle", constrained: "the constrained restyle", "plan-mode": "constrained, with a reviewed plan" },
  l4: { approve: "approve the plan as-is", revise: "revise the plan before approving" },
  l5: { plan: "run in plan mode", acceptEdits: "run in acceptEdits mode", bypass: "run with bypassPermissions" },
  l6: { clean: "the clean change", "planted-bug": "the change with a planted bug" },
  l7: { without: "run without CLAUDE.md", with: "run with a CLAUDE.md conventions file" },
  l8: { haiku: "run on Haiku", sonnet: "run on Sonnet" },
};

/** @param {string} title */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Converts one legacy lesson entry into a Lesson Engine document.
 *
 * @param {object} legacy entry from the legacy lessons.json
 * @param {number} order 1-based position in the spine
 * @param {string|null} prevId
 * @param {string|null} nextId
 * @returns {object}
 */
export function convertLesson(legacy, order, prevId, nextId) {
  const id = legacy.lessonId;
  const fixtures = {};
  const branches = {};
  for (const branchId of legacy.branches) {
    const config = legacy.branchConfig[branchId];
    fixtures[branchId] = { path: config.fixture, kind: "claudeStream" };
    branches[branchId] = {
      fixture: branchId,
      expectedPrompt: config.expectedPrompt,
      permissionMode: config.permissionMode,
      ...(config.seedSnapshotId ? { seedSnapshotId: config.seedSnapshotId } : {}),
      ...(config.model ? { model: config.model } : {}),
    };
  }

  const suggestions = legacy.branches.map((branchId) => ({
    text: legacy.branchConfig[branchId].expectedPrompt,
    description: BRANCH_DESCRIPTIONS[id]?.[branchId] ?? branchId,
    branchId,
  }));

  const steps = [
    { type: "instruction", id: "intro", md: INSTRUCTION_MD[id] ?? `**${legacy.title}.**` },
    { type: "promptBuilder", id: "compose", suggestions },
    {
      type: "run",
      id: "run",
      branches,
      ...(legacy.playback === "step" ? { pacing: "step" } : {}),
    },
  ];

  if (legacy.assertion.type === "quiz") {
    steps.push({
      type: "quiz",
      id: "quiz",
      question: legacy.assertion.question,
      options: legacy.assertion.choices,
      answerIdx: legacy.assertion.correctIndex,
    });
    steps.push({ type: "assertion", id: "grade", rule: { type: "quizCorrect", stepId: "quiz" } });
  } else {
    steps.push({ type: "assertion", id: "grade", rule: legacy.assertion });
  }

  return {
    schemaVersion: LESSON_SCHEMA_VERSION,
    id,
    slug: slugify(legacy.title),
    title: legacy.title,
    track: "guided",
    order,
    durationTargetSec: 300,
    prereqs: prevId ? [prevId] : [],
    ...(legacy.locked !== undefined ? { locked: legacy.locked } : {}),
    snapshot: { snapshotId: legacy.seedSnapshotId },
    fixtures,
    steps,
    completion: { assertionIds: ["grade"], next: nextId },
  };
}

/**
 * @param {object} legacyManifest the legacy {lessons: [...]} manifest
 * @returns {object[]} converted lesson documents, in spine order
 */
export function convertAll(legacyManifest) {
  const lessons = legacyManifest.lessons;
  return lessons.map((legacy, i) =>
    convertLesson(legacy, i + 1, lessons[i - 1]?.lessonId ?? null, lessons[i + 1]?.lessonId ?? null),
  );
}

function main(argv) {
  const args = argv.slice(2);
  const outFlag = args.indexOf("--out");
  const outDir = outFlag === -1 ? DEFAULT_OUT_DIR : args[outFlag + 1];
  const legacyPath = args.find((a) => !a.startsWith("--") && a !== outDir) ?? DEFAULT_LEGACY;

  const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  const docs = convertAll(legacy);
  mkdirSync(outDir, { recursive: true });
  for (const doc of docs) {
    const file = join(outDir, `${doc.id}.yaml`);
    writeFileSync(file, stringifyYaml(doc, { lineWidth: 0 }));
    console.log(`wrote ${file}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
