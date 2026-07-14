/**
 * Validate + seed stage: Zod → structural lint → seed through the EXISTING
 * seeder path (injected Runner) → staging-tree compile (committed lessons +
 * draft, committed fixtures + draft fixtures) → assertion verification
 * against the really-recorded streams/workspaces → redaction grep.
 *
 * Returns {schemaPass, seedPass, report, artifacts}: schemaPass covers
 * schema+lint+compile (the draft is structurally publishable), seedPass
 * covers "the authored prompts satisfy their own assertion when actually
 * run" — the spec's un-gameable author metric.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateLessonDoc } from "@guided-repl/protocol";
import { compileAll } from "@guided-repl/lessons";
import { seedFromDoc } from "guided-repl-seeder/src/docRecipe.js";

import { lintLessonDoc, llmLint } from "../lint/lessonLint.js";
import { findRedactionLeaks } from "../redaction.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_LESSONS_DIR = path.resolve(PKG_ROOT, "../../packages/guided-repl-lessons/lessons");
export const DEFAULT_FIXTURES_ROOT = path.resolve(PKG_ROOT, "../../apps/guided-repl/public/fixtures/v1");

/**
 * Verifies a lesson assertion rule against one branch's real post-run
 * workspace snapshot + recorded stream text.
 *
 * @param {object} rule assertion rule (workspace-checkable subset)
 * @param {{files: {path: string, content: string}[]}} postSnapshot
 * @param {import("@guided-repl/protocol").FixtureEvent[]} events
 * @returns {{pass: boolean, detail: string}}
 */
export function verifyAssertion(rule, postSnapshot, events) {
  const file = (p) => postSnapshot.files.find((f) => f.path === p);
  switch (rule.type) {
    case "file-exists": {
      return file(rule.path)
        ? { pass: true, detail: `${rule.path} exists` }
        : { pass: false, detail: `${rule.path} missing from post-run workspace` };
    }
    case "file-contains": {
      const f = file(rule.path);
      if (!f) return { pass: false, detail: `${rule.path} missing from post-run workspace` };
      return f.content.includes(rule.match)
        ? { pass: true, detail: `${rule.path} contains ${JSON.stringify(rule.match)}` }
        : { pass: false, detail: `${rule.path} does not contain ${JSON.stringify(rule.match)}` };
    }
    case "file-equals": {
      const f = file(rule.path);
      if (!f) return { pass: false, detail: `${rule.path} missing from post-run workspace` };
      return f.content === rule.content
        ? { pass: true, detail: `${rule.path} matches exactly` }
        : { pass: false, detail: `${rule.path} differs from expected content` };
    }
    case "terminal-matches": {
      const text = events
        .filter((e) => e.frame?.type === "text")
        .map((e) => e.frame.payload?.delta ?? "")
        .join("");
      return text.includes(rule.match)
        ? { pass: true, detail: `stream text contains ${JSON.stringify(rule.match)}` }
        : { pass: false, detail: `stream text does not contain ${JSON.stringify(rule.match)}` };
    }
    default:
      return { pass: false, detail: `assertion type "${rule.type}" is not verifiable against a workspace` };
  }
}

/** Copies a directory tree of JSON/YAML assets into a staging dir. */
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

/**
 * @param {object} opts
 * @param {object} opts.doc author-validated lesson doc
 * @param {string} opts.yamlText the draft YAML source (committed verbatim on merge)
 * @param {import("guided-repl-seeder/src/runner/runner.js").Runner} opts.runner
 * @param {() => string} opts.versionProvider claude version for fixture stamps
 * @param {string} [opts.lessonsDir] committed lesson YAML dir
 * @param {string} [opts.fixturesRoot] committed fixtures root
 * @param {{complete: Function}} [opts.agentClient] enables the optional LLM lint
 * @param {boolean} [opts.llmLintEnabled]
 * @returns {Promise<{schemaPass: boolean, seedPass: boolean, report: object, artifacts: {fixtures: object[], seedSnapshot: object, manifest: object|null}}>}
 */
export async function validateDraft({
  doc,
  yamlText,
  runner,
  versionProvider,
  lessonsDir = DEFAULT_LESSONS_DIR,
  fixturesRoot = DEFAULT_FIXTURES_ROOT,
  agentClient,
  llmLintEnabled = false,
}) {
  const report = {
    schema: { pass: false, error: null },
    lint: { pass: false, failures: [] },
    seed: { pass: false, branches: [], error: null },
    compile: { pass: false, error: null },
    redaction: { pass: false, leaks: [] },
    llmLint: null,
  };
  const artifacts = { fixtures: [], seedSnapshot: null, manifest: null };

  // 1. Zod schema.
  try {
    validateLessonDoc(doc);
    report.schema.pass = true;
  } catch (err) {
    report.schema.error = err.message;
    return { schemaPass: false, seedPass: false, report, artifacts };
  }

  // 2. Structural lint (+ v1 draft constraints).
  const lint = lintLessonDoc(doc);
  report.lint.pass = lint.ok;
  report.lint.failures = lint.failures;
  if (!lint.ok) {
    return { schemaPass: false, seedPass: false, report, artifacts };
  }

  // 3. Seed through the existing recorder path with the injected runner,
  // then verify the assertion against each branch's REAL post-run state.
  try {
    const { fixtures, seedSnapshot } = await seedFromDoc({ doc, runner, versionProvider });
    artifacts.fixtures = fixtures;
    artifacts.seedSnapshot = seedSnapshot;
    const assertionRule = doc.steps.find((s) => s.type === "assertion").rule;
    for (const { branchId, fixture, postSnapshot } of fixtures) {
      const verdict = verifyAssertion(assertionRule, postSnapshot, fixture.events);
      report.seed.branches.push({ branchId, ...verdict });
    }
    report.seed.pass = report.seed.branches.length > 0 && report.seed.branches.every((b) => b.pass);
  } catch (err) {
    report.seed.error = err.message;
    report.seed.pass = false;
  }

  // 4. Staging compile: committed lessons + draft YAML over committed
  // fixtures + freshly seeded draft fixtures. Exercises anchors,
  // suggestion/branch coverage, envelope cross-checks, order uniqueness.
  if (report.seed.error === null && artifacts.fixtures.length > 0) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-staging-"));
    try {
      const stagingLessons = path.join(staging, "lessons");
      const stagingFixtures = path.join(staging, "fixtures-root");
      copyTree(lessonsDir, stagingLessons);
      copyTree(fixturesRoot, stagingFixtures);
      fs.writeFileSync(path.join(stagingLessons, `${doc.id}.yaml`), yamlText);
      for (const { branchId, fixture } of artifacts.fixtures) {
        const p = path.join(stagingFixtures, "fixtures", doc.id, `${branchId}.json`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `${JSON.stringify(fixture, null, 2)}\n`);
      }
      fs.writeFileSync(
        path.join(stagingFixtures, "snapshots", `${artifacts.seedSnapshot.snapshotId}.json`),
        `${JSON.stringify(artifacts.seedSnapshot, null, 2)}\n`,
      );

      artifacts.manifest = compileAll({ lessonsDir: stagingLessons, fixturesRoot: stagingFixtures });
      report.compile.pass = true;
    } catch (err) {
      report.compile.error = err.message;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  // 5. Redaction grep over everything that would enter the PR.
  const texts = [
    ["draft yaml", yamlText],
    ...artifacts.fixtures.map((f) => [`fixture ${f.branchId}`, JSON.stringify(f.fixture)]),
    ...(artifacts.seedSnapshot ? [["seed snapshot", JSON.stringify(artifacts.seedSnapshot)]] : []),
  ];
  for (const [label, text] of texts) {
    for (const leak of findRedactionLeaks(text)) {
      report.redaction.leaks.push({ where: label, ...leak });
    }
  }
  report.redaction.pass = report.redaction.leaks.length === 0;

  // 6. Optional advisory LLM lint.
  if (llmLintEnabled && agentClient) {
    report.llmLint = await llmLint({ agentClient, yamlText });
  }

  const schemaPass = report.schema.pass && report.lint.pass && report.compile.pass && report.redaction.pass;
  const seedPass = report.seed.pass;
  return { schemaPass, seedPass, report, artifacts };
}
