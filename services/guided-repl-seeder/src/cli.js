#!/usr/bin/env node
/**
 * seed-lessons CLI.
 *
 * Usage:
 *   seed-lessons <lessonId|all> [--branch <id>] [--out <dir>]
 *
 * Drives real `claude -p` sessions via LocalRunner in throwaway tmp
 * workspaces, maps/normalizes/paces the resulting stream into protocol
 * frames, snapshots the workspace before/after, and writes fixture JSON.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotWorkspace } from "./snapshotter.js";
import { buildFixture, writeJson } from "./fixtureWriter.js";
import { applyAuthorGate, applyMultiPlanGate } from "./authorGate.js";
import { mergeAnnotations } from "./annotationMerge.js";
import { makeWorkspaceFromSnapshot } from "./workspace.js";
import { recipes, CHAIN_ORDER } from "./recipes/index.js";
import {
  getClaudeCodeVersion,
  makeSeedWorkspace,
  recordSimpleBranch,
  recordPlanBranch,
  runSegment,
} from "./seedLib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEDER_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SEEDER_ROOT, "..", "..");
const APP_FIXTURES_DIR = path.join(REPO_ROOT, "apps", "guided-repl", "public", "fixtures", "v1");
const LESSONS_JSON_PATH = path.join(APP_FIXTURES_DIR, "lessons.json");

/**
 * Parses argv (excluding node/script) into the seed-lessons options.
 *
 * @param {string[]} argv
 * @returns {{lessonId: string, branch: string|null, out: string|null}}
 */
export function parseArgs(argv) {
  const [lessonId, ...rest] = argv;
  if (!lessonId) {
    throw new Error("Usage: seed-lessons <lessonId|all> [--branch <id>] [--out <dir>]");
  }

  let branch = null;
  let out = null;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--branch") {
      branch = rest[++i] ?? null;
      if (branch === null) throw new Error("--branch requires a value");
    } else if (arg === "--out") {
      out = rest[++i] ?? null;
      if (out === null) throw new Error("--out requires a value");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { lessonId, branch, out };
}

/**
 * Records lesson l1's 3 branches and writes fixtures + snapshots to
 * `outDir`, then mirrors them into the app's public fixtures directory.
 *
 * @param {{branch: string|null, outDir: string}} opts
 */
async function seedLessonOne(opts) {
  const lessons = JSON.parse(fs.readFileSync(LESSONS_JSON_PATH, "utf8"));
  const l1 = lessons.lessons.find((l) => l.lessonId === "l1");
  if (!l1) throw new Error("l1 not found in lessons.json");

  const claudeCodeVersion = getClaudeCodeVersion();
  const branchesToRun = opts.branch ? [opts.branch] : l1.branches;

  let seedSnapshot = null;
  let outputSnapshot = null;
  const fixtures = [];

  for (const branchId of branchesToRun) {
    const config = l1.branchConfig[branchId];
    if (!config) throw new Error(`Unknown branch: ${branchId}`);

    console.log(`[seed-lessons] recording l1/${branchId} ...`);

    const common = {
      lessonId: "l1",
      branchId,
      expectedPrompt: config.expectedPrompt,
      assertion: l1.assertion,
      claudeCodeVersion,
      seedSnapshotId: l1.seedSnapshotId,
    };

    const { fixture, workspace } =
      branchId === "plan-mode"
        ? await recordPlanBranch(common)
        : await recordSimpleBranch({ ...common, permissionMode: config.permissionMode });

    if (!seedSnapshot) {
      // l1-input is identical across freshly-seeded branch workspaces;
      // capture it once, before this branch's run already mutated things.
      // (Re-derive from a throwaway fresh workspace to guarantee pristine state.)
      const pristine = makeSeedWorkspace();
      seedSnapshot = snapshotWorkspace(pristine, l1.seedSnapshotId);
      fs.rmSync(pristine, { recursive: true, force: true });
    }

    if (branchId === "constrained") {
      outputSnapshot = snapshotWorkspace(workspace, "l1-output");
    }

    fixtures.push({ branchId, fixture });
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  // --- write to outDir ---
  for (const { branchId, fixture } of fixtures) {
    writeJson(fixture, path.join(opts.outDir, "fixtures", "l1", `${branchId}.json`));
  }
  if (seedSnapshot) {
    writeJson(seedSnapshot, path.join(opts.outDir, "snapshots", "l1-input.json"));
  }
  if (outputSnapshot) {
    writeJson(outputSnapshot, path.join(opts.outDir, "snapshots", "l1-output.json"));
  }

  // --- mirror into apps/guided-repl/public/fixtures/v1 ---
  for (const { branchId, fixture } of fixtures) {
    writeJson(fixture, path.join(APP_FIXTURES_DIR, "fixtures", "l1", `${branchId}.json`));
  }
  if (seedSnapshot) {
    writeJson(seedSnapshot, path.join(APP_FIXTURES_DIR, "snapshots", "l1-input.json"));
  }
  if (outputSnapshot) {
    writeJson(outputSnapshot, path.join(APP_FIXTURES_DIR, "snapshots", "l1-output.json"));
  }

  console.log(`[seed-lessons] wrote ${fixtures.length} fixture(s) to ${opts.outDir} and ${APP_FIXTURES_DIR}`);
}

/**
 * Reads a published snapshot by id from the app's fixtures dir — the
 * canonical location every lesson's output snapshot is mirrored to, so
 * lessons 3-8 can be seeded from the prior lesson's output regardless of
 * `--out`.
 *
 * @param {string} snapshotId
 * @returns {import("@guided-repl/protocol").SnapshotManifest}
 */
function loadPublishedSnapshot(snapshotId) {
  const p = path.join(APP_FIXTURES_DIR, "snapshots", `${snapshotId}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`seed-lessons: snapshot "${snapshotId}" not found at ${p} — record the prior lesson first`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * L2's merge-only "recording": attaches hand-authored annotations to a copy
 * of a prior lesson's fixture (per `recipe.source`) and rewrites its
 * lessonId/branchId. No live `claude` run.
 *
 * @param {object} recipe
 * @param {{outDir: string}} opts
 */
function seedMergeLesson(recipe, opts) {
  const sourcePath = path.join(opts.outDir, "fixtures", recipe.source.lessonId, `${recipe.source.branchId}.json`);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`seed-lessons: merge source not found at ${sourcePath} — record ${recipe.source.lessonId} first`);
  }
  const sourceFixture = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const merged = mergeAnnotations(sourceFixture, {
    lessonId: recipe.lessonId,
    branchId: recipe.branchId,
    annotations: recipe.annotations,
  });

  writeJson(merged, path.join(opts.outDir, "fixtures", recipe.lessonId, `${recipe.branchId}.json`));
  writeJson(merged, path.join(APP_FIXTURES_DIR, "fixtures", recipe.lessonId, `${recipe.branchId}.json`));

  console.log(
    `[seed-lessons] merged ${recipe.lessonId}/${recipe.branchId} from ${recipe.source.lessonId}/${recipe.source.branchId} (no live run)`
  );
}

/**
 * Records every (or one, via `opts.branch`) branch of a recipe-driven
 * lesson (l3-l8): seeds each branch's workspace from the recipe's base
 * snapshot (plus any branch-specific extra files), runs the branch's
 * `claude -p` segment(s) per its `kind`, snapshots the designated output
 * branch's post-run workspace as `<lessonId>-output`, and writes/mirrors
 * fixtures + snapshots exactly like `seedLessonOne`.
 *
 * @param {string} lessonId
 * @param {{branch: string|null, outDir: string}} opts
 */
async function seedRecipeLesson(lessonId, opts) {
  const recipe = recipes[lessonId];
  if (!recipe) throw new Error(`Unknown lessonId: ${lessonId}`);
  if (recipe.kind === "merge") {
    seedMergeLesson(recipe, opts);
    return;
  }

  const lessons = JSON.parse(fs.readFileSync(LESSONS_JSON_PATH, "utf8"));
  const lesson = lessons.lessons.find((l) => l.lessonId === lessonId);
  if (!lesson) throw new Error(`${lessonId} not found in lessons.json`);

  const claudeCodeVersion = getClaudeCodeVersion();
  const branchesToRun = opts.branch ? [opts.branch] : lesson.branches;
  const baseSnapshot = loadPublishedSnapshot(recipe.seedFrom);

  const fixtures = [];
  const extraInputSnapshots = [];
  let outputSnapshot = null;

  for (const branchId of branchesToRun) {
    const branchRecipe = recipe.branches[branchId];
    if (!branchRecipe) throw new Error(`Unknown branch: ${branchId} for ${lessonId}`);
    const cfg = lesson.branchConfig[branchId];
    if (!cfg) throw new Error(`Missing branchConfig for ${lessonId}/${branchId}`);

    console.log(`[seed-lessons] recording ${lessonId}/${branchId} ...`);

    const extraFiles = branchRecipe.extraFiles ?? [];
    const seedSnapshotId = cfg.seedSnapshotId ?? lesson.seedSnapshotId;

    // Branch-specific input snapshot (e.g. L7's l7-input-plain/l7-input-claudemd):
    // captured once, from a pristine copy, before this branch's run mutates it.
    if (branchRecipe.snapshotId) {
      const pristine = makeWorkspaceFromSnapshot(baseSnapshot, extraFiles);
      extraInputSnapshots.push(snapshotWorkspace(pristine, branchRecipe.snapshotId));
      fs.rmSync(pristine, { recursive: true, force: true });
    }

    const workspace = makeWorkspaceFromSnapshot(baseSnapshot, extraFiles);
    const permissionMode = cfg.permissionMode;

    let events;
    if (branchRecipe.kind === "simple") {
      events = await runSegment({ prompt: cfg.expectedPrompt, cwd: workspace, permissionMode });
    } else if (branchRecipe.kind === "model") {
      events = await runSegment({
        prompt: cfg.expectedPrompt,
        cwd: workspace,
        permissionMode,
        model: branchRecipe.model,
      });
    } else if (branchRecipe.kind === "plan") {
      const planEvents = await runSegment({ prompt: cfg.expectedPrompt, cwd: workspace, permissionMode: "plan" });
      const execEvents = await runSegment({ prompt: cfg.expectedPrompt, cwd: workspace, permissionMode: "acceptEdits" });
      events = applyAuthorGate(planEvents, execEvents);
    } else if (branchRecipe.kind === "multiplan") {
      const variants = recipe.promptVariants?.[branchId] ?? {};
      const segmentEvents = [];
      for (const segName of branchRecipe.segments) {
        const segPrompt = variants[segName] ?? cfg.expectedPrompt;
        const segPermissionMode = segName === "exec" ? "acceptEdits" : "plan";
        segmentEvents.push(await runSegment({ prompt: segPrompt, cwd: workspace, permissionMode: segPermissionMode }));
      }
      events = applyMultiPlanGate(segmentEvents, branchRecipe.gates);
    } else {
      throw new Error(`Unknown recipe kind "${branchRecipe.kind}" for ${lessonId}/${branchId}`);
    }

    const fixture = buildFixture({
      lessonId,
      branchId,
      claudeCodeVersion,
      seedSnapshotId,
      permissionMode,
      expectedPrompt: cfg.expectedPrompt,
      events,
      assertion: lesson.assertion,
    });

    if (branchId === recipe.outputBranch) {
      outputSnapshot = snapshotWorkspace(workspace, `${lessonId}-output`);
    }

    fixtures.push({ branchId, fixture });
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  const allSnapshots = [...extraInputSnapshots, ...(outputSnapshot ? [outputSnapshot] : [])];

  for (const dir of [opts.outDir, APP_FIXTURES_DIR]) {
    for (const { branchId, fixture } of fixtures) {
      writeJson(fixture, path.join(dir, "fixtures", lessonId, `${branchId}.json`));
    }
    for (const snapshot of allSnapshots) {
      writeJson(snapshot, path.join(dir, "snapshots", `${snapshot.snapshotId}.json`));
    }
  }

  console.log(
    `[seed-lessons] wrote ${fixtures.length} fixture(s) and ${allSnapshots.length} snapshot(s) to ${opts.outDir} and ${APP_FIXTURES_DIR}`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out ?? path.join(SEEDER_ROOT, "output", "v1");

  if (opts.lessonId === "l1") {
    await seedLessonOne({ branch: opts.branch, outDir });
  } else if (opts.lessonId === "all") {
    await seedLessonOne({ branch: opts.branch, outDir });
    for (const lessonId of CHAIN_ORDER) {
      await seedRecipeLesson(lessonId, { branch: opts.branch, outDir });
    }
  } else if (recipes[opts.lessonId]) {
    await seedRecipeLesson(opts.lessonId, { branch: opts.branch, outDir });
  } else {
    throw new Error(`Unknown lessonId: ${opts.lessonId} (expected "l1", "all", or one of ${Object.keys(recipes).join(", ")})`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
