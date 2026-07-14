/**
 * Author stage: one AgentClient call (role: author) → fenced YAML → parsed +
 * Zod-validated lesson doc with provenance. One retry on any failure — agent/
 * SDK (e.g. error_max_turns) or parse/validation — with the error message
 * appended to the prompt.
 */

import { parse as parseYaml } from "yaml";
import { validateLessonDoc } from "@guided-repl/protocol";
import { buildFixedBlock, buildTopicBlock, buildAuthorPrompt } from "./promptPack.js";

/**
 * @param {string} text model response
 * @returns {string} the fenced yaml payload
 */
export function extractYamlBlock(text) {
  const fenced = text.match(/```(?:yaml|yml)\s*\n([\s\S]*?)```/i);
  if (!fenced) {
    throw new Error("author: response contains no fenced ```yaml block");
  }
  return fenced[1];
}

/** @param {import("../agent/pricing.js").Usage[]} usages */
function sumTokens(usages) {
  const total = { input_tokens: 0, output_tokens: 0 };
  for (const u of usages) {
    total.input_tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    total.output_tokens += u.output_tokens ?? 0;
  }
  return total;
}

/**
 * Drafts one lesson from a radar card + source pack.
 *
 * @param {object} opts
 * @param {{complete: Function}} opts.agentClient
 * @param {{topic: string, whyNow?: string}} opts.card
 * @param {import("../sources/fetchers.js").SourceItem[]} [opts.sourceItems]
 * @param {string} [opts.fixedBlock] pass to reuse one byte-stable block per run
 * @param {string} [opts.model] explicit model override (bench harness)
 * @returns {Promise<{doc: object, yamlText: string, provenance: {role: string, model: string, costUsd: number, tokens: {input_tokens: number, output_tokens: number}, attempts: number}}>}
 */
export async function authorDraft({ agentClient, card, sourceItems = [], fixedBlock, model }) {
  const fixed = fixedBlock ?? buildFixedBlock();
  const basePrompt = buildAuthorPrompt(fixed, buildTopicBlock(card, sourceItems));

  const usages = [];
  let costUsd = 0;
  let resolvedModel = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\n---\n\nYour previous draft was rejected: ${lastError.message}\n` +
          "Fix the problem and respond again with a single fenced ```yaml block.";

    try {
      // The complete() call is inside the try so agent/SDK failures (e.g.
      // error_max_turns) are retried too, not just bad-output failures.
      const result = await agentClient.complete({ role: "author", prompt, model });
      usages.push(result.usage);
      costUsd += result.costUsd;
      resolvedModel = result.model;

      const yamlText = extractYamlBlock(result.text);
      const doc = validateLessonDoc(parseYaml(yamlText));
      return {
        doc,
        yamlText,
        provenance: {
          role: "author",
          model: resolvedModel,
          costUsd,
          tokens: sumTokens(usages),
          attempts: attempt,
        },
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`author: draft failed after retry — ${lastError.message}`);
}
