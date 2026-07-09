/**
 * Lesson compiler: YAML sources in lessons/ → validated canonical JSON
 * manifest (dist/lessons.json). Broken refs, unresolvable annotation
 * anchors, and suggestion/branch coverage gaps fail the build, not learners.
 *
 * CLI:
 *   node src/compile.js                 build dist/lessons.json
 *   node src/compile.js --check         compile in memory and diff against
 *                                       the app's committed lessons.json
 *   node src/compile.js --fixtures-root <dir>   override fixture asset root
 *   node src/compile.js --out <file>            override output path
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  validateLessonDoc,
  validateLessonManifest,
  validateFixture,
  validateSnapshot,
  resolveAnchor,
  LESSON_SCHEMA_VERSION,
} from "@guided-repl/protocol";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LESSONS_DIR = join(PKG_ROOT, "lessons");
const DEFAULT_FIXTURES_ROOT = resolve(PKG_ROOT, "../../apps/guided-repl/public/fixtures/v1");
const DEFAULT_OUT = join(PKG_ROOT, "dist/lessons.json");
const APP_MANIFEST = resolve(PKG_ROOT, "../../apps/guided-repl/public/fixtures/v1/lessons.json");

/** Same normalization as the app's matchPrompt — the binding contract. */
function normalize(text) {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * @param {string} fixturesRoot
 * @param {string} relPath
 * @param {string} context error-message prefix
 * @returns {object} parsed JSON
 */
function loadJson(fixturesRoot, relPath, context) {
  const abs = join(fixturesRoot, relPath);
  if (!existsSync(abs)) {
    throw new Error(`${context}: file not found — ${relPath}`);
  }
  return JSON.parse(readFileSync(abs, "utf8"));
}

/**
 * Validates a promptBuilder step's suggestions (and optional slots) against
 * its run step's branches. Every suggestion must resolve to exactly one
 * branch; every branch must be reachable by at least one suggestion; when
 * slots are present, every slot combination must resolve to a branch.
 *
 * @param {object} lesson
 * @param {object} builderStep
 * @param {object} runStep
 */
function checkPromptCoverage(lesson, builderStep, runStep) {
  const ctx = `lesson ${lesson.id} step ${builderStep.id}`;
  const branches = Object.entries(runStep.branches);
  const covered = new Set();

  for (const suggestion of builderStep.suggestions) {
    const matches = branches.filter(([, b]) => normalize(b.expectedPrompt) === normalize(suggestion.text));
    if (suggestion.branchId !== undefined) {
      const target = runStep.branches[suggestion.branchId];
      if (!target) {
        throw new Error(`${ctx}: suggestion "${suggestion.text}" names unknown branch "${suggestion.branchId}"`);
      }
      if (normalize(target.expectedPrompt) !== normalize(suggestion.text)) {
        throw new Error(`${ctx}: suggestion "${suggestion.text}" does not match branch "${suggestion.branchId}" expectedPrompt`);
      }
      covered.add(suggestion.branchId);
      continue;
    }
    if (matches.length === 0) {
      throw new Error(`${ctx}: suggestion "${suggestion.text}" matches no branch expectedPrompt`);
    }
    if (matches.length > 1) {
      throw new Error(
        `${ctx}: suggestion "${suggestion.text}" is ambiguous across branches ${matches.map(([id]) => id).join(", ")} — set branchId`,
      );
    }
    covered.add(matches[0][0]);
  }

  for (const [branchId] of branches) {
    if (!covered.has(branchId)) {
      throw new Error(`${ctx}: branch "${branchId}" is not reachable by any suggestion`);
    }
  }

  if (builderStep.slots?.length) {
    const combos = builderStep.slots.reduce(
      (acc, slot) => acc.flatMap((prefix) => slot.choices.map((c) => (prefix ? `${prefix} ${c}` : c))),
      [""],
    );
    for (const combo of combos) {
      const hits = branches.filter(([, b]) => normalize(b.expectedPrompt) === normalize(combo));
      if (hits.length !== 1) {
        throw new Error(`${ctx}: slot combination "${combo}" does not resolve to exactly one branch`);
      }
    }
  }
}

/**
 * Compiles one parsed lesson document: validates it, resolves fixture and
 * snapshot refs, stamps annotation resolvedEventIndex, and runs the
 * suggestion/branch coverage check.
 *
 * @param {unknown} doc parsed YAML
 * @param {string} fixturesRoot
 * @returns {object} the compiled lesson
 */
export function compileLesson(doc, fixturesRoot) {
  const lesson = validateLessonDoc(doc);
  const ctx = `lesson ${lesson.id}`;

  const fixtureData = {};
  for (const [key, ref] of Object.entries(lesson.fixtures)) {
    const fixture = loadJson(fixturesRoot, ref.path, `${ctx} fixtures.${key}`);
    try {
      validateFixture(fixture);
    } catch (err) {
      throw new Error(`${ctx} fixtures.${key}: ${err.message}`);
    }
    const fixtureKind = fixture.kind ?? "claudeStream";
    if (fixtureKind !== ref.kind) {
      throw new Error(`${ctx} fixtures.${key}: declared kind "${ref.kind}" but fixture is "${fixtureKind}"`);
    }
    fixtureData[key] = fixture;
  }

  const snapshotIds = new Set([lesson.snapshot.snapshotId]);
  for (const step of lesson.steps) {
    if (step.type !== "run") continue;
    for (const [branchId, branch] of Object.entries(step.branches)) {
      const bctx = `${ctx} run ${step.id} branch ${branchId}`;
      const fixture = fixtureData[branch.fixture];
      if (fixture.kind === "shellTranscript") {
        throw new Error(`${bctx}: run branches must reference claudeStream fixtures`);
      }
      if (fixture.lessonId !== lesson.id) {
        throw new Error(`${bctx}: fixture lessonId "${fixture.lessonId}" does not match`);
      }
      if (fixture.branchId !== branchId) {
        throw new Error(`${bctx}: fixture branchId "${fixture.branchId}" does not match`);
      }
      if (normalize(fixture.expectedPrompt) !== normalize(branch.expectedPrompt)) {
        throw new Error(`${bctx}: expectedPrompt does not match fixture`);
      }
      if (fixture.permissionMode !== branch.permissionMode) {
        throw new Error(`${bctx}: permissionMode "${branch.permissionMode}" does not match fixture "${fixture.permissionMode}"`);
      }
      const seedId = branch.seedSnapshotId ?? lesson.snapshot.snapshotId;
      if (fixture.seedSnapshotId !== seedId) {
        throw new Error(`${bctx}: seedSnapshotId "${seedId}" does not match fixture "${fixture.seedSnapshotId}"`);
      }
      snapshotIds.add(seedId);
    }
  }

  for (const step of lesson.steps) {
    if (step.type === "terminalDrill" && fixtureData[step.transcript].kind !== "shellTranscript") {
      throw new Error(`${ctx} step ${step.id}: transcript fixture must be kind shellTranscript`);
    }
  }

  for (const snapshotId of snapshotIds) {
    const snapshot = loadJson(fixturesRoot, `snapshots/${snapshotId}.json`, `${ctx} snapshot ${snapshotId}`);
    try {
      validateSnapshot(snapshot);
    } catch (err) {
      throw new Error(`${ctx} snapshot ${snapshotId}: ${err.message}`);
    }
  }

  const steps = lesson.steps.map((step) => {
    if (step.type !== "annotation") return step;
    const index = resolveAnchor(step.anchor, fixtureData[step.fixtureKey].events);
    if (index === null) {
      throw new Error(`${ctx} step ${step.id}: anchor did not resolve against ${step.fixtureKey}`);
    }
    return { ...step, resolvedEventIndex: index };
  });

  const builders = lesson.steps.filter((s) => s.type === "promptBuilder");
  for (const builder of builders) {
    const builderIdx = lesson.steps.indexOf(builder);
    const runStep = lesson.steps.slice(builderIdx + 1).find((s) => s.type === "run");
    if (!runStep) {
      throw new Error(`${ctx} step ${builder.id}: no run step follows this promptBuilder`);
    }
    checkPromptCoverage(lesson, builder, runStep);
  }

  return { ...lesson, steps };
}

/**
 * Compiles every lesson YAML in a directory into an ordered manifest.
 *
 * @param {object} [opts]
 * @param {string} [opts.lessonsDir]
 * @param {string} [opts.fixturesRoot]
 * @returns {{schemaVersion: number, lessons: object[]}}
 */
export function compileAll({ lessonsDir = DEFAULT_LESSONS_DIR, fixturesRoot = DEFAULT_FIXTURES_ROOT } = {}) {
  const files = readdirSync(lessonsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No lesson YAML files found in ${lessonsDir}`);
  }
  const lessons = files.map((file) => {
    const doc = parseYaml(readFileSync(join(lessonsDir, file), "utf8"));
    try {
      return compileLesson(doc, fixturesRoot);
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  });
  lessons.sort((a, b) => a.order - b.order);

  const seen = new Set();
  for (const lesson of lessons) {
    if (seen.has(lesson.order)) throw new Error(`Duplicate lesson order ${lesson.order}`);
    seen.add(lesson.order);
  }
  for (const lesson of lessons) {
    if (lesson.completion.next !== null && !lessons.some((l) => l.id === lesson.completion.next)) {
      throw new Error(`lesson ${lesson.id}: completion.next "${lesson.completion.next}" is not a known lesson`);
    }
    for (const prereq of lesson.prereqs) {
      if (!lessons.some((l) => l.id === prereq)) {
        throw new Error(`lesson ${lesson.id}: prereq "${prereq}" is not a known lesson`);
      }
    }
  }

  const manifest = { schemaVersion: LESSON_SCHEMA_VERSION, lessons };
  validateLessonManifest(manifest);
  return manifest;
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const fixturesRoot = flag("--fixtures-root") ?? DEFAULT_FIXTURES_ROOT;
  const outPath = flag("--out") ?? DEFAULT_OUT;

  const manifest = compileAll({ fixturesRoot });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (args.includes("--check")) {
    if (!existsSync(APP_MANIFEST)) {
      console.error(`check: app manifest not found at ${APP_MANIFEST}`);
      process.exit(1);
    }
    const committed = readFileSync(APP_MANIFEST, "utf8");
    if (committed !== json) {
      console.error(
        "check: apps/guided-repl/public/fixtures/v1/lessons.json is out of date — run `npm run build` in packages/guided-repl-lessons and copy dist/lessons.json over it",
      );
      process.exit(1);
    }
    console.log(`check: OK — committed lessons.json matches ${manifest.lessons.length} compiled lesson(s).`);
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  console.log(`compiled ${manifest.lessons.length} lesson(s) → ${outPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(`compile failed: ${err.message}`);
    process.exit(1);
  }
}
