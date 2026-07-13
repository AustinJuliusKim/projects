#!/usr/bin/env node
/**
 * Compiled-manifest <-> fixtures consistency check.
 *
 * Verifies that public/fixtures/<version>/lessons.json (the compiled output
 * of @guided-repl/lessons), its referenced fixture files, and its referenced
 * seed snapshots are mutually consistent and free of leaked local-machine
 * data, before they ship.
 *
 * Checks:
 *   (a) the manifest passes the protocol's Zod lesson schema
 *   (b) every run-branch/annotation/drill fixture file exists, passes
 *       validateFixture, and matches its declared kind
 *   (c) each claudeStream fixture's envelope {lessonId, branchId,
 *       expectedPrompt, permissionMode, seedSnapshotId} matches the lesson's
 *       run step
 *   (d) seed snapshot files exist and pass validateSnapshot
 *   (e) every annotation step's semantic anchor still resolves against the
 *       shipped fixture to its compiled resolvedEventIndex (re-seed drift gate)
 *   (f) promptBuilder suggestion <-> run-branch coverage: every suggestion
 *       resolves to exactly one branch, every branch is reachable
 *   (g) snapshot-chain consistency (l1 -> l3 -> ... -> l8, l2 reuse, l7
 *       plain/claudemd special case)
 *   (h) redaction grep over the manifest and every fixture/snapshot file
 *   (i) drift: recompiling the YAML sources reproduces the committed manifest
 *   (j) token lint: {{userName}} is the only interpolation token allowed in
 *       the manifest and fixture/snapshot files (typo/unknown-token gate)
 *
 * Usage: node scripts/checkLessons.js
 * Exit code is non-zero (with precise error messages on stderr) on any
 * violation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLessonManifest, validateFixture, validateSnapshot, resolveAnchor } from "@guided-repl/protocol";
import { compileAll } from "@guided-repl/lessons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const fixtureVersion = process.env.VITE_FIXTURE_VERSION || "v1";
const fixturesRoot = join(appRoot, "public", "fixtures", fixtureVersion);
const lessonsPath = join(fixturesRoot, "lessons.json");

/** Recorded (non-merge) lesson chain order; l2 reuses l1's own snapshot. */
const CHAIN = ["l1", "l3", "l4", "l5", "l6", "l7", "l8"];
const FIXTURE_SIZE_WARN_BYTES = 256 * 1024;
const warnings = [];

/** Redaction patterns: every match here is a leak that must not ship. */
const REDACTION_PATTERNS = [
  { name: "/Users/ path", re: /\/Users\// },
  { name: "/private path", re: /\/private/ },
  { name: "/var/folders path", re: /\/var\/folders/ },
  { name: "dash-mangled -private-var-folders- path", re: /-private-var-folders-/ },
  { name: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "UUIDv4", re: /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i },
  { name: "sk-ant- key", re: /sk-ant-/ },
];

const errors = [];

function fail(msg) {
  errors.push(msg);
}

/** Same normalization as matchPrompt — the binding contract. */
function normalize(text) {
  return text.trim().replace(/\s+/g, " ");
}

function readJson(path, label) {
  if (!existsSync(path)) {
    fail(`${label}: file does not exist: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${label}: invalid JSON in ${path} — ${err.message}`);
    return null;
  }
}

if (!existsSync(lessonsPath)) {
  console.error(`checkLessons: lessons.json not found at ${lessonsPath}`);
  process.exit(1);
}

// (a) schema validation of the shipped manifest.
const rawManifest = readJson(lessonsPath, "lessons.json");
let manifest = null;
try {
  manifest = validateLessonManifest(rawManifest);
} catch (err) {
  console.error(`checkLessons: lessons.json failed the lesson schema — ${err.message}`);
  process.exit(1);
}

const activeLessons = manifest.lessons.filter((l) => !l.locked);
const checkedFiles = new Set([lessonsPath]);

for (const lesson of activeLessons) {
  const prefix = `lesson ${lesson.id}`;

  // Load + validate every fixture the lesson references, keyed for reuse.
  const fixtureData = {};
  for (const [key, ref] of Object.entries(lesson.fixtures)) {
    const fixturePath = join(fixturesRoot, ref.path);
    if (!existsSync(fixturePath)) {
      fail(`${prefix} fixtures.${key}: fixture file does not exist: ${fixturePath}`);
      continue;
    }
    checkedFiles.add(fixturePath);
    const fixture = readJson(fixturePath, `${prefix} fixtures.${key}`);
    if (!fixture) continue;
    try {
      validateFixture(fixture);
    } catch (err) {
      fail(`${prefix} fixtures.${key}: fixture failed validateFixture — ${err.message}`);
      continue;
    }
    // (b) declared kind matches the fixture (absent = claudeStream).
    const fixtureKind = fixture.kind ?? "claudeStream";
    if (fixtureKind !== ref.kind) {
      fail(`${prefix} fixtures.${key}: declared kind "${ref.kind}" but fixture is "${fixtureKind}"`);
      continue;
    }
    fixtureData[key] = fixture;

    const sizeBytes = statSync(fixturePath).size;
    if (sizeBytes > FIXTURE_SIZE_WARN_BYTES) {
      warnings.push(`${prefix} fixtures.${key}: fixture is ${(sizeBytes / 1024).toFixed(1)}KB (> 256KB) — ${fixturePath}`);
    }
  }

  const snapshotIds = new Set([lesson.snapshot.snapshotId]);

  for (const step of lesson.steps) {
    // (c) claudeStream envelope cross-checks per run branch.
    if (step.type === "run") {
      for (const [branchId, branch] of Object.entries(step.branches)) {
        const branchPrefix = `${prefix} / branch ${branchId}`;
        const fixture = fixtureData[branch.fixture];
        if (!fixture) continue; // already reported above
        if ((fixture.kind ?? "claudeStream") !== "claudeStream") {
          fail(`${branchPrefix}: run branches must reference claudeStream fixtures`);
          continue;
        }
        if (fixture.lessonId !== lesson.id) {
          fail(`${branchPrefix}: fixture.lessonId "${fixture.lessonId}" does not match "${lesson.id}"`);
        }
        if (fixture.branchId !== branchId) {
          fail(`${branchPrefix}: fixture.branchId "${fixture.branchId}" does not match branch "${branchId}"`);
        }
        if (normalize(fixture.expectedPrompt) !== normalize(branch.expectedPrompt)) {
          fail(`${branchPrefix}: fixture.expectedPrompt ${JSON.stringify(fixture.expectedPrompt)} does not match run branch ${JSON.stringify(branch.expectedPrompt)}`);
        }
        if (fixture.permissionMode !== branch.permissionMode) {
          fail(`${branchPrefix}: fixture.permissionMode ${JSON.stringify(fixture.permissionMode)} does not match run branch ${JSON.stringify(branch.permissionMode)}`);
        }
        const expectedSeed = branch.seedSnapshotId ?? lesson.snapshot.snapshotId;
        if (fixture.seedSnapshotId !== expectedSeed) {
          fail(`${branchPrefix}: fixture.seedSnapshotId ${JSON.stringify(fixture.seedSnapshotId)} does not match ${JSON.stringify(expectedSeed)}`);
        }
        snapshotIds.add(expectedSeed);
      }
    }

    // (e) anchor re-resolution against the shipped fixture.
    if (step.type === "annotation") {
      const fixture = fixtureData[step.fixtureKey];
      if (fixture) {
        const index = resolveAnchor(step.anchor, fixture.events);
        if (index === null) {
          fail(`${prefix} step ${step.id}: anchor no longer resolves against ${step.fixtureKey} (re-seed drift?)`);
        } else if (index !== step.resolvedEventIndex) {
          fail(`${prefix} step ${step.id}: anchor resolves to event ${index} but the compiled manifest says ${step.resolvedEventIndex} — recompile the lessons package`);
        }
      }
    }

    if (step.type === "terminalDrill") {
      const fixture = fixtureData[step.transcript];
      if (fixture && fixture.kind !== "shellTranscript") {
        fail(`${prefix} step ${step.id}: transcript fixture must be kind shellTranscript`);
      }
    }

    // (f) suggestion <-> branch coverage.
    if (step.type === "promptBuilder") {
      const stepIdx = lesson.steps.indexOf(step);
      const runStep = lesson.steps.slice(stepIdx + 1).find((s) => s.type === "run");
      if (!runStep) {
        fail(`${prefix} step ${step.id}: no run step follows this promptBuilder`);
        continue;
      }
      const covered = new Set();
      for (const suggestion of step.suggestions) {
        if (suggestion.branchId !== undefined) {
          const target = runStep.branches[suggestion.branchId];
          if (!target) {
            fail(`${prefix} step ${step.id}: suggestion "${suggestion.text}" names unknown branch "${suggestion.branchId}"`);
          } else if (normalize(target.expectedPrompt) !== normalize(suggestion.text)) {
            fail(`${prefix} step ${step.id}: suggestion "${suggestion.text}" does not match branch "${suggestion.branchId}" expectedPrompt`);
          } else {
            covered.add(suggestion.branchId);
          }
          continue;
        }
        const matches = Object.entries(runStep.branches).filter(
          ([, b]) => normalize(b.expectedPrompt) === normalize(suggestion.text),
        );
        if (matches.length !== 1) {
          fail(`${prefix} step ${step.id}: suggestion "${suggestion.text}" resolves to ${matches.length} branches — set branchId`);
        } else {
          covered.add(matches[0][0]);
        }
      }
      for (const branchId of Object.keys(runStep.branches)) {
        if (!covered.has(branchId)) {
          fail(`${prefix} step ${step.id}: branch "${branchId}" is not reachable by any suggestion`);
        }
      }
    }
  }

  // (d) seed snapshots exist and validate.
  for (const snapshotId of snapshotIds) {
    const snapshotPath = join(fixturesRoot, "snapshots", `${snapshotId}.json`);
    if (!existsSync(snapshotPath)) {
      fail(`${prefix}: seed snapshot file does not exist: ${snapshotPath}`);
      continue;
    }
    checkedFiles.add(snapshotPath);
    const snapshot = readJson(snapshotPath, `${prefix} seed snapshot`);
    if (snapshot) {
      try {
        validateSnapshot(snapshot);
      } catch (err) {
        fail(`${prefix}: seed snapshot failed validateSnapshot — ${err.message}`);
      }
    }
  }
}

// (g) chain consistency: l1 -> l3 -> l4 -> l5 -> l6 -> l7 -> l8's snapshot
// must equal the prior recorded lesson's <lessonId>-output; l2 reuses l1's
// own snapshot (it replays l1's constrained run from l1's start state);
// l7 is special-cased since its lesson-level snapshot is a *variant* of
// l6-output (the plain/CLAUDE.md branch input snapshots).
const byId = new Map(manifest.lessons.map((l) => [l.id, l]));

const l1 = byId.get("l1");
const l2 = byId.get("l2");
if (l1 && l2 && l2.snapshot.snapshotId !== l1.snapshot.snapshotId) {
  fail(`chain: l2 snapshot ${JSON.stringify(l2.snapshot.snapshotId)} does not reuse l1's ${JSON.stringify(l1.snapshot.snapshotId)}`);
}

for (let i = 1; i < CHAIN.length; i++) {
  const prevId = CHAIN[i - 1];
  const curId = CHAIN[i];
  const cur = byId.get(curId);
  if (!byId.get(prevId) || !cur) continue; // missing-lesson already reported elsewhere if active
  const expectedInput = `${prevId}-output`;

  if (curId === "l7") {
    // l7-input-plain must be a byte-for-byte copy of the prior output
    // snapshot's files; l7-input-claudemd must be l7-input-plain plus a
    // CLAUDE.md file (and otherwise identical).
    const prevSnapshot = readJson(join(fixturesRoot, "snapshots", `${expectedInput}.json`), `chain: ${expectedInput} snapshot`);
    const plainSnapshot = readJson(join(fixturesRoot, "snapshots", "l7-input-plain.json"), "chain: l7-input-plain snapshot");
    const claudeMdSnapshot = readJson(join(fixturesRoot, "snapshots", "l7-input-claudemd.json"), "chain: l7-input-claudemd snapshot");
    if (prevSnapshot && plainSnapshot) {
      const sameFiles = JSON.stringify([...prevSnapshot.files].sort((a, b) => a.path.localeCompare(b.path))) ===
        JSON.stringify([...plainSnapshot.files].sort((a, b) => a.path.localeCompare(b.path)));
      if (!sameFiles) {
        fail(`chain: l7-input-plain does not match ${expectedInput}'s files`);
      }
    }
    if (plainSnapshot && claudeMdSnapshot) {
      const plainPaths = new Set(plainSnapshot.files.map((f) => f.path));
      const extraFiles = claudeMdSnapshot.files.filter((f) => !plainPaths.has(f.path));
      if (!extraFiles.some((f) => f.path === "CLAUDE.md")) {
        fail("chain: l7-input-claudemd does not add a CLAUDE.md file relative to l7-input-plain");
      }
    }
    continue;
  }

  if (cur.snapshot.snapshotId !== expectedInput) {
    fail(`chain: ${curId} snapshot ${JSON.stringify(cur.snapshot.snapshotId)} does not match ${prevId}'s output snapshot ${JSON.stringify(expectedInput)}`);
  }
}

// Also sweep every snapshot file physically present under snapshots/ (not
// just ones referenced by an active lesson), so orphaned/leaked snapshot
// files still get redaction-checked below.
const snapshotsDir = join(fixturesRoot, "snapshots");
if (existsSync(snapshotsDir)) {
  for (const entry of readdirSync(snapshotsDir)) {
    if (entry.endsWith(".json")) {
      checkedFiles.add(join(snapshotsDir, entry));
    }
  }
}

// (h) redaction grep over the manifest and every fixture/snapshot file.
// (j) token lint: any "{{" not immediately opening "{{userName}}" is a
// typo'd or unknown interpolation token — the player would ship it verbatim.
const UNKNOWN_TOKEN_RE = /\{\{(?!userName\}\})/;
for (const filePath of checkedFiles) {
  if (!existsSync(filePath)) continue;
  const raw = readFileSync(filePath, "utf8");
  for (const { name, re } of REDACTION_PATTERNS) {
    const match = raw.match(re);
    if (match) {
      fail(`redaction: ${filePath} contains a ${name} match: ${JSON.stringify(match[0])}`);
    }
  }
  const tokenMatch = raw.match(UNKNOWN_TOKEN_RE);
  if (tokenMatch) {
    const at = tokenMatch.index ?? 0;
    fail(`token lint: ${filePath} contains a non-{{userName}} "{{" token near ${JSON.stringify(raw.slice(at, at + 24))}`);
  }
}

// (i) drift: recompiling the YAML sources must reproduce the committed
// manifest byte-for-byte (modulo the trailing newline the compiler writes).
try {
  const recompiled = `${JSON.stringify(compileAll({ fixturesRoot }), null, 2)}\n`;
  const committed = readFileSync(lessonsPath, "utf8");
  if (recompiled !== committed) {
    fail(
      "drift: lessons.json does not match the compiled YAML sources — run `npm run build` in packages/guided-repl-lessons and copy dist/lessons.json over public/fixtures/v1/lessons.json",
    );
  }
} catch (err) {
  fail(`drift: recompiling the lessons package failed — ${err.message}`);
}

if (warnings.length > 0) {
  console.warn(`checkLessons: ${warnings.length} warning(s):\n`);
  for (const w of warnings) {
    console.warn(`  - ${w}`);
  }
}

if (errors.length > 0) {
  console.error(`checkLessons: ${errors.length} problem(s) found:\n`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`checkLessons: OK — ${activeLessons.length} active lesson(s), ${checkedFiles.size} file(s) checked, no redaction leaks.`);
