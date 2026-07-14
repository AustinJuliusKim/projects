/**
 * Draft PR bundle: writes the complete working set for one lesson draft PR
 * to an out dir — repo-relative files (lesson YAML, fixtures, snapshots,
 * recompiled lessons.json), PR body (the review card, with provenance
 * frontmatter), provenance.json, and meta.json (branch name, labels, file
 * map). NO git operations here — the workflow copies files, commits, and
 * opens the draft PR; a human merging IS the publish gate.
 */

import fs from "node:fs";
import path from "node:path";

import { assertRedacted } from "../redaction.js";

/** @param {Date} d */
function dateStamp(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** @param {boolean} pass */
function mark(pass) {
  return pass ? "PASS" : "FAIL";
}

/**
 * @param {object} opts
 * @param {object} opts.doc validated draft doc
 * @param {string} opts.yamlText
 * @param {object} opts.provenance {role, model, costUsd, tokens, attempts}
 * @param {{schemaPass: boolean, seedPass: boolean, report: object, artifacts: object}} opts.validation
 * @param {{topic: string, whyNow?: string, sources?: string[], overlapScore?: number, nearestLessonId?: string}} opts.card
 * @param {object} opts.settings parsed settings.yaml
 * @param {string} opts.outDir
 * @param {() => Date} [opts.now]
 * @param {string} [opts.tokenWarning] extra PR-body warning (e.g. GITHUB_TOKEN fallback)
 * @returns {{dir: string, branchName: string, labels: string[], title: string, files: string[]}}
 */
export function buildDraftBundle({ doc, yamlText, provenance, validation, card, settings, outDir, now = () => new Date(), tokenWarning }) {
  const stamp = dateStamp(now());
  const dir = path.join(outDir, `draft-${doc.id}`);
  const branchName = `${settings.branchPrefix}draft-${doc.id}-${stamp}`;
  const labels = [settings.labels.draft];
  const title = `Foundry draft: ${doc.title} (${doc.id})`;

  const { report, artifacts } = validation;

  /** repo-relative file map, mirrored under the bundle dir */
  const files = [];
  const writeRepoFile = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    files.push(rel);
  };

  writeRepoFile(`packages/guided-repl-lessons/lessons/${doc.id}.yaml`, yamlText);
  for (const { branchId, fixture } of artifacts.fixtures) {
    writeRepoFile(
      `apps/guided-repl/public/fixtures/v1/fixtures/${doc.id}/${branchId}.json`,
      `${JSON.stringify(fixture, null, 2)}\n`,
    );
  }
  if (artifacts.seedSnapshot) {
    writeRepoFile(
      `apps/guided-repl/public/fixtures/v1/snapshots/${artifacts.seedSnapshot.snapshotId}.json`,
      `${JSON.stringify(artifacts.seedSnapshot, null, 2)}\n`,
    );
  }
  if (artifacts.manifest) {
    // The recompiled staging manifest, byte-formatted like the drift gate expects.
    writeRepoFile(
      "apps/guided-repl/public/fixtures/v1/lessons.json",
      `${JSON.stringify(artifacts.manifest, null, 2)}\n`,
    );
  }

  const seedLines = report.seed.branches.map((b) => `- \`${b.branchId}\`: ${mark(b.pass)} — ${b.detail}`);
  const seedRatio = `${report.seed.branches.filter((b) => b.pass).length}/${report.seed.branches.length}`;
  const lintLines = report.lint.failures.map((f) => `- ${f.rule}: ${f.message}`);
  const sources = (card.sources ?? []).map((s) => `- ${s}`);

  const prBody = `---
role: ${provenance.role}
model: ${provenance.model}
costUsd: ${provenance.costUsd.toFixed(4)}
tokens:
  input: ${provenance.tokens.input_tokens}
  output: ${provenance.tokens.output_tokens}
attempts: ${provenance.attempts}
---

# Foundry draft: ${doc.title}

Machine-drafted lesson \`${doc.id}\` — review, edit, and **merging this PR is
the publish action** (guided-repl CI then validates and deploys).
${tokenWarning ? `\n> **Warning:** ${tokenWarning}\n` : ""}
## Why now

${card.whyNow ?? "(hand-picked topic)"}
${card.overlapScore !== undefined ? `\nOverlap score: **${card.overlapScore.toFixed(2)}** (nearest: ${card.nearestLessonId ?? "n/a"}, threshold ${settings.overlapThreshold})` : ""}

Primary sources:
${sources.length ? sources.join("\n") : "- (none recorded)"}

## Validation

| gate | result |
| --- | --- |
| schema (Zod) | ${mark(report.schema.pass)} |
| structural lint | ${mark(report.lint.pass)} |
| seed-pass | ${mark(report.seed.pass)} (${seedRatio} branches) |
| staging compile (anchors, coverage, drift shape) | ${mark(report.compile.pass)} |
| redaction | ${mark(report.redaction.pass)} |
${lintLines.length ? `\nLint failures:\n${lintLines.join("\n")}\n` : ""}
Seed report (assertions verified against the real recorded runs):
${seedLines.join("\n")}
${report.llmLint ? `\nAdvisory LLM lint (${report.llmLint.model}):\n\n${report.llmLint.notes}\n` : ""}
## Cost report

- author: $${provenance.costUsd.toFixed(4)} (${provenance.tokens.input_tokens} in / ${provenance.tokens.output_tokens} out tokens, ${provenance.attempts} attempt(s), ${provenance.model})

## Licensing / originality checklist (reviewer)

- [ ] Expression is original — no reproduction or close paraphrase of any
      registry course content (registry courses are radar, not raw material)
- [ ] Claims are grounded in the primary sources listed above
- [ ] Pedagogy sanity: branches are true counterfactuals, quiz tests the insight
- [ ] Copy is on-voice for guided-repl

## Preview locally

\`\`\`
cd apps/guided-repl && npm run dev
\`\`\`

## Ops tasks

None — merging deploys through the existing guided-repl CI.
`;

  assertRedacted(prBody, `draft PR body for ${doc.id}`);
  fs.writeFileSync(path.join(dir, "PR_BODY.md"), prBody);
  fs.writeFileSync(path.join(dir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const meta = {
    kind: "draft",
    lessonId: doc.id,
    branchName,
    labels,
    title,
    commitMessage: `foundry: draft lesson ${doc.id} — ${doc.title}`,
    prBodyFile: "PR_BODY.md",
    files,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  return { dir, branchName, labels, title, files };
}
