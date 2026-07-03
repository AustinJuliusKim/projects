#!/usr/bin/env node
/**
 * DAG <-> fixtures consistency check.
 *
 * Verifies that public/fixtures/<version>/lessons.json, its referenced
 * fixture files, and its referenced seed snapshots are mutually consistent
 * and free of leaked local-machine data, before they ship.
 *
 * Checks:
 *   (a) every active lesson's branches[] <-> branchConfig keys match exactly
 *   (b) every branchConfig.fixture file exists and passes validateFixture
 *   (c) each fixture's envelope {lessonId, branchId, expectedPrompt,
 *       permissionMode, seedSnapshotId} matches lessons.json
 *   (d) seed snapshot files exist and pass validateSnapshot
 *   (e) exactly one assertion per active lesson, and it passes validateAssertion
 *   (f) redaction grep over every fixture/snapshot JSON file: zero matches for
 *       /Users/, /private, /var/folders, the dash-mangled form of those, an
 *       email regex, a UUIDv4 regex, and sk-ant- key-shaped strings
 *
 * Usage: node scripts/checkLessons.js
 * Exit code is non-zero (with precise error messages on stderr) on any
 * violation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFixture, validateSnapshot, validateAssertion } from "@guided-repl/protocol";

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

const lessonsDoc = readJson(lessonsPath, "lessons.json");
if (!lessonsDoc || !Array.isArray(lessonsDoc.lessons)) {
  console.error("checkLessons: lessons.json missing top-level 'lessons' array");
  process.exit(1);
}

const activeLessons = lessonsDoc.lessons.filter((l) => !l.locked);
const checkedFiles = new Set([lessonsPath]);

for (const lesson of activeLessons) {
  const { lessonId } = lesson;
  const prefix = `lesson ${lessonId}`;

  // (a) branches[] <-> branchConfig keys match exactly, both directions.
  const branches = Array.isArray(lesson.branches) ? lesson.branches : [];
  const branchConfig = lesson.branchConfig && typeof lesson.branchConfig === "object" ? lesson.branchConfig : {};
  const branchSet = new Set(branches);
  const configSet = new Set(Object.keys(branchConfig));

  for (const b of branchSet) {
    if (!configSet.has(b)) {
      fail(`${prefix}: branches[] has "${b}" but branchConfig is missing an entry for it`);
    }
  }
  for (const b of configSet) {
    if (!branchSet.has(b)) {
      fail(`${prefix}: branchConfig has "${b}" but branches[] does not list it`);
    }
  }

  // (e) exactly one assertion per active lesson, and it must validate.
  if (lesson.assertion === undefined) {
    fail(`${prefix}: missing assertion`);
  } else {
    try {
      validateAssertion(lesson.assertion);
    } catch (err) {
      fail(`${prefix}: assertion invalid — ${err.message}`);
    }
  }

  // (b) + (c) per-branch fixture checks.
  for (const branchId of branches) {
    const cfg = branchConfig[branchId];
    if (!cfg) continue; // already reported above

    const branchPrefix = `${prefix} / branch ${branchId}`;

    if (!cfg.fixture || typeof cfg.fixture !== "string") {
      fail(`${branchPrefix}: branchConfig entry missing a "fixture" path`);
      continue;
    }

    const fixturePath = join(fixturesRoot, cfg.fixture);
    if (!existsSync(fixturePath)) {
      fail(`${branchPrefix}: fixture file does not exist: ${fixturePath}`);
      continue;
    }
    checkedFiles.add(fixturePath);

    const fixture = readJson(fixturePath, branchPrefix);
    if (!fixture) continue;

    try {
      validateFixture(fixture);
    } catch (err) {
      fail(`${branchPrefix}: fixture failed validateFixture — ${err.message}`);
      continue;
    }

    if (fixture.lessonId !== lessonId) {
      fail(`${branchPrefix}: fixture.lessonId "${fixture.lessonId}" does not match lessons.json "${lessonId}"`);
    }
    if (fixture.branchId !== branchId) {
      fail(`${branchPrefix}: fixture.branchId "${fixture.branchId}" does not match branch "${branchId}"`);
    }
    if (fixture.expectedPrompt !== cfg.expectedPrompt) {
      fail(
        `${branchPrefix}: fixture.expectedPrompt ${JSON.stringify(fixture.expectedPrompt)} does not match lessons.json branchConfig.expectedPrompt ${JSON.stringify(cfg.expectedPrompt)}`
      );
    }
    if (fixture.permissionMode !== cfg.permissionMode) {
      fail(
        `${branchPrefix}: fixture.permissionMode ${JSON.stringify(fixture.permissionMode)} does not match lessons.json branchConfig.permissionMode ${JSON.stringify(cfg.permissionMode)}`
      );
    }
    // Branches may override the lesson-level seedSnapshotId (e.g. L7's
    // without/with CLAUDE.md branches carry distinct input snapshots).
    const expectedSeedSnapshotId = cfg.seedSnapshotId ?? lesson.seedSnapshotId;
    if (fixture.seedSnapshotId !== expectedSeedSnapshotId) {
      fail(
        `${branchPrefix}: fixture.seedSnapshotId ${JSON.stringify(fixture.seedSnapshotId)} does not match lessons.json seedSnapshotId ${JSON.stringify(expectedSeedSnapshotId)}`
      );
    }
    if (cfg.seedSnapshotId) {
      const overridePath = join(fixturesRoot, "snapshots", `${cfg.seedSnapshotId}.json`);
      if (!existsSync(overridePath)) {
        fail(`${branchPrefix}: per-branch seed snapshot file does not exist: ${overridePath}`);
      } else {
        checkedFiles.add(overridePath);
        const overrideSnapshot = readJson(overridePath, `${branchPrefix} seed snapshot`);
        if (overrideSnapshot) {
          try {
            validateSnapshot(overrideSnapshot);
          } catch (err) {
            fail(`${branchPrefix}: per-branch seed snapshot failed validateSnapshot — ${err.message}`);
          }
        }
      }
    }

    // (f) fixture-size warning.
    const sizeBytes = statSync(fixturePath).size;
    if (sizeBytes > FIXTURE_SIZE_WARN_BYTES) {
      warnings.push(`${branchPrefix}: fixture is ${(sizeBytes / 1024).toFixed(1)}KB (> 256KB) — ${fixturePath}`);
    }
  }

  // (d) seed snapshot exists and validates.
  if (!lesson.seedSnapshotId) {
    fail(`${prefix}: missing seedSnapshotId`);
  } else {
    const snapshotPath = join(fixturesRoot, "snapshots", `${lesson.seedSnapshotId}.json`);
    if (!existsSync(snapshotPath)) {
      fail(`${prefix}: seed snapshot file does not exist: ${snapshotPath}`);
    } else {
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
}

// (chain consistency) l1 -> l3 -> l4 -> l5 -> l6 -> l7 -> l8's seedSnapshotId
// must equal the prior recorded lesson's <lessonId>-output; l2 reuses l1's
// own seedSnapshotId (it replays l1's constrained run from l1's start
// state, not l1's end state); l7 is special-cased since its lesson-level
// seedSnapshotId is a *variant* of l6-output (the plain/CLAUDE.md branch
// input snapshots), not l6-output verbatim.
const byId = new Map(lessonsDoc.lessons.map((l) => [l.lessonId, l]));

const l1 = byId.get("l1");
const l2 = byId.get("l2");
if (l1 && l2 && l2.seedSnapshotId !== l1.seedSnapshotId) {
  fail(`chain: l2.seedSnapshotId ${JSON.stringify(l2.seedSnapshotId)} does not reuse l1.seedSnapshotId ${JSON.stringify(l1.seedSnapshotId)}`);
}

for (let i = 1; i < CHAIN.length; i++) {
  const prevId = CHAIN[i - 1];
  const curId = CHAIN[i];
  const prev = byId.get(prevId);
  const cur = byId.get(curId);
  if (!prev || !cur) continue; // missing-lesson already reported elsewhere if active
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

  if (cur.seedSnapshotId !== expectedInput) {
    fail(`chain: ${curId}.seedSnapshotId ${JSON.stringify(cur.seedSnapshotId)} does not match ${prevId}'s output snapshot ${JSON.stringify(expectedInput)}`);
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

// (f) redaction grep over every fixture/snapshot JSON file.
for (const filePath of checkedFiles) {
  if (!existsSync(filePath)) continue;
  const raw = readFileSync(filePath, "utf8");
  for (const { name, re } of REDACTION_PATTERNS) {
    const match = raw.match(re);
    if (match) {
      fail(`redaction: ${filePath} contains a ${name} match: ${JSON.stringify(match[0])}`);
    }
  }
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
