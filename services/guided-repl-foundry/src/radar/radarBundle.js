/**
 * Radar/state PR bundle: scout source notes (foundry/notes/YYYY-MM/*.md),
 * the updated cursors.json, and a radar.md card summary recording every
 * gate/budget decision. Like draftBundle: files + PR body + meta only —
 * NO git operations.
 */

import fs from "node:fs";
import path from "node:path";

import { assertRedacted } from "../redaction.js";

/** @param {Date} d */
function monthDir(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * @param {object} opts
 * @param {{sourceId: string, path: string, markdown: string}[]} opts.notes
 * @param {object[]} opts.cards radar cards with decisions stamped:
 *   {topic, whyNow, kind, sourceId, overlapScore?, nearestLessonId?,
 *    decision: "drafted"|"gated-out"|"over-budget"|"bench"|"skipped", reason?}
 * @param {{sources: Record<string, object>}} opts.cursors updated cursor state
 * @param {{sourceId: string, message: string}[]} opts.errors
 * @param {object} opts.settings
 * @param {string} opts.outDir
 * @param {{scout: {calls: number, costUsd: number}, author: {drafts: number, costUsd: number}, totalUsd: number}} [opts.usage] run spend breakdown
 * @param {() => Date} [opts.now]
 * @returns {{dir: string, branchName: string, labels: string[], title: string, files: string[]}}
 */
export function buildRadarBundle({ notes, cards, cursors, errors, settings, outDir, usage, now = () => new Date() }) {
  const month = monthDir(now());
  const dir = path.join(outDir, `radar-${month}`);
  const branchName = `${settings.branchPrefix}radar-${month}`;
  const labels = [settings.labels.radar];
  const title = `Foundry radar: ${month}`;

  const files = [];
  const writeRepoFile = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    files.push(rel);
  };

  for (const note of notes) {
    assertRedacted(note.markdown, `radar bundle note ${note.sourceId}`);
    writeRepoFile(`foundry/${note.path}`, note.markdown);
  }
  writeRepoFile("foundry/state/cursors.json", `${JSON.stringify(cursors, null, 2)}\n`);

  const cardLines = cards.map((c) => {
    const score = c.overlapScore !== undefined ? c.overlapScore.toFixed(2) : "—";
    const reason = c.reason ? ` — ${c.reason}` : "";
    return `| ${c.topic} | ${c.kind} | ${c.sourceId} | ${score} | ${c.decision}${reason} |`;
  });
  const errorLines = errors.map((e) => `- \`${e.sourceId}\`: ${e.message}`);
  const radarMd = `# Topic Radar — ${month}

| topic | kind | source | overlap | decision |
| --- | --- | --- | --- | --- |
${cardLines.join("\n") || "| (no cards this run) | | | | |"}

${errorLines.length ? `## Source errors\n\n${errorLines.join("\n")}\n` : ""}${
    usage
      ? `## Run spend\n\n- scout: ${usage.scout.calls} call(s), $${usage.scout.costUsd.toFixed(4)}\n` +
        `- author: ${usage.author.drafts} draft(s), $${usage.author.costUsd.toFixed(4)}\n` +
        `- total: $${usage.totalUsd.toFixed(4)}\n`
      : ""
  }`;
  assertRedacted(radarMd, "radar.md");
  writeRepoFile(`foundry/notes/${month}/radar.md`, radarMd);

  const benchCards = cards.filter((c) => c.kind === "bench");
  const prBody = `# Foundry radar — ${month}

Scout notes, Topic Radar decisions, and updated source cursors for this
cadence run. Merging records institutional memory; it publishes no lessons.
${benchCards.length ? `\n> **Model landscape:** ${benchCards.length} bench trigger(s) fired — consider running \`foundry bench\` (see radar.md).\n` : ""}
See \`foundry/notes/${month}/radar.md\` for the full card table.

## Ops tasks

None.
`;
  assertRedacted(prBody, "radar PR body");
  fs.writeFileSync(path.join(dir, "PR_BODY.md"), prBody);

  const meta = {
    kind: "radar",
    branchName,
    labels,
    title,
    commitMessage: `foundry: radar + source notes ${month}`,
    prBodyFile: "PR_BODY.md",
    files,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  return { dir, branchName, labels, title, files };
}
