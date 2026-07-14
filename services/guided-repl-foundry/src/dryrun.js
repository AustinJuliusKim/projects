/**
 * Built-in --dry-run fakes: exercise the full spine end-to-end with zero
 * network, zero keys, zero `claude` CLI — deterministic canned scout/author
 * responses and a fake Runner that really writes the assertion target into
 * the workspace, so validate+seed behaves exactly like a live run.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** @param {string} s */
function yamlQuote(s) {
  return JSON.stringify(s);
}

/** A deterministic, schema-valid draft for a given topic (unique id per topic). */
export function dryRunDraftYaml(topic) {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "dry-run-topic";
  const id = `d${createHash("sha256").update(topic).digest("hex").slice(0, 6)}`;
  return `schemaVersion: 1
id: ${id}
slug: ${slug}
title: ${yamlQuote(topic)}
track: advanced
order: 9
durationTargetSec: 300
prereqs: []
snapshot:
  snapshotId: ${id}-input
fixtures:
  direct:
    path: fixtures/${id}/direct.json
    kind: claudeStream
  planned:
    path: fixtures/${id}/planned.json
    kind: claudeStream
steps:
  - type: instruction
    id: intro
    md: >-
      **Dry-run draft.** Two ways to approach the task — head-on, or plan
      first and watch the plan gate.
  - type: promptBuilder
    id: compose
    suggestions:
      - text: write eval.md with the recall results
        description: go direct
        branchId: direct
      - text: plan an eval, then write eval.md with the recall results
        description: plan first
        branchId: planned
  - type: run
    id: run
    branches:
      direct:
        fixture: direct
        expectedPrompt: write eval.md with the recall results
        permissionMode: acceptEdits
      planned:
        fixture: planned
        expectedPrompt: plan an eval, then write eval.md with the recall results
        permissionMode: plan
  - type: assertion
    id: grade
    rule:
      type: file-contains
      path: eval.md
      match: recall
completion:
  assertionIds:
    - grade
  next: null
`;
}

const DRY_SCOUT_REPLY = (sourceId) =>
  [
    `Dry-run summary for ${sourceId}: one notable item, worth a lesson probe.`,
    "```json",
    JSON.stringify({
      cards: [
        {
          topic: `Dry-run topic from ${sourceId}`,
          whyNow: "dry-run canned card",
          sources: [`https://example.com/${sourceId}`],
          suggestedTrack: "advanced",
        },
      ],
    }),
    "```",
  ].join("\n");

/**
 * @returns {import("./agent/agentClient.js").QueryImpl} canned scout/author/linter responses
 */
export function createDryRunQueryImpl() {
  return async ({ role, prompt }) => {
    if (role === "scout") {
      const sourceId = prompt.match(/^Source: (.+)$/m)?.[1] ?? "unknown";
      return { text: DRY_SCOUT_REPLY(sourceId), usage: { input_tokens: 2_000, output_tokens: 400 } };
    }
    if (role === "author") {
      const topic = prompt.match(/^Topic: (.+)$/m)?.[1] ?? "Dry-run topic";
      return {
        text: `\`\`\`yaml\n${dryRunDraftYaml(topic)}\`\`\``,
        usage: { input_tokens: 50_000, output_tokens: 4_000 },
      };
    }
    return { text: "LGTM", usage: { input_tokens: 5_000, output_tokens: 100 } };
  };
}

/** One canned item per source; no network. */
export async function dryRunFetchSource(source) {
  return [
    {
      id: `${source.id}-dry-1`,
      title: `Dry-run item for ${source.id}`,
      url: `https://example.com/${source.id}`,
      date: "2026-07-01T00:00:00Z",
      body: "Canned dry-run source item.",
    },
  ];
}

/**
 * Fake Runner: emits a realistic mini stream and really writes the eval.md
 * the dry-run draft asserts on. Plan segments only narrate.
 *
 * @returns {import("guided-repl-seeder/src/runner/runner.js").Runner & {getVersion: () => string}}
 */
export function createDryRunRunner() {
  return {
    getVersion: () => "0.0.0-dry-run (Claude Code)",
    run({ cwd, permissionMode }) {
      const realCwd = fs.realpathSync(cwd);
      const events = [{ type: "system", subtype: "init", cwd: realCwd, model: "claude-dry-run", permissionMode }];
      if (permissionMode === "plan") {
        events.push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Plan: compute recall, write eval.md." } },
        });
      } else {
        const abs = path.join(realCwd, "eval.md");
        fs.writeFileSync(abs, "recall: 0.82\n");
        events.push(
          { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Writing eval.md" } } },
          { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_dry_1", name: "Write", input: { file_path: abs, content: "recall: 0.82\n" } }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_dry_1", content: "ok" }] } },
        );
      }
      events.push({ type: "result", subtype: "success", usage: { input_tokens: 900, output_tokens: 200 } });
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}
