/**
 * AgentClient: the single injectable boundary in front of the Claude Agent
 * SDK. Everything in the Foundry that talks to a model goes through
 * `complete({role, system, prompt, model?})`.
 *
 * The default `queryImpl` lazily imports `@anthropic-ai/claude-agent-sdk`
 * inside the first call — constructing a client performs no network I/O and
 * no SDK import, so tests and keyless CI never touch the live path (they
 * inject a fake queryImpl instead).
 */

import { costForModel } from "./pricing.js";

/**
 * @typedef {object} QueryRequest
 * @property {string} prompt
 * @property {string} [system]
 * @property {string} model
 * @property {string} [role] metadata for fakes/telemetry; the live path ignores it
 *
 * @typedef {object} QueryResult
 * @property {string} text final assistant text
 * @property {import("./pricing.js").Usage} usage
 *
 * @typedef {(req: QueryRequest) => Promise<QueryResult>} QueryImpl
 */

/**
 * Live path: drives the Agent SDK's query() with no tools — Foundry prompts
 * are fully context-stuffed (sources are fetched by the pipeline, not by the
 * agent), so `allowedTools: []` and a single turn.
 *
 * @type {QueryImpl}
 */
async function defaultQueryImpl({ prompt, system, model }) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const stream = query({
    prompt,
    options: {
      model,
      ...(system ? { systemPrompt: system } : {}),
      allowedTools: [],
      maxTurns: 1,
    },
  });

  let text = "";
  let usage = {};
  let resultSeen = false;
  for await (const message of stream) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text") text += block.text;
      }
    } else if (message.type === "result") {
      resultSeen = true;
      usage = message.usage ?? {};
      if (message.subtype && message.subtype !== "success") {
        throw new Error(`agentClient: query ended with ${message.subtype}`);
      }
      if (typeof message.result === "string" && message.result.length > 0) {
        text = message.result;
      }
    }
  }
  if (!resultSeen) {
    throw new Error("agentClient: query stream ended without a result message");
  }
  return { text, usage };
}

/**
 * @param {object} opts
 * @param {QueryImpl} [opts.queryImpl] injected in tests/CI; defaults to the live Agent SDK path
 * @param {{roles: Record<string, {model: string}>}} opts.models parsed models.yaml
 * @param {Record<string, {inputPerMTok: number, outputPerMTok: number}>} opts.pricing settings.pricing
 * @param {Record<string, string>} [opts.overrides] per-run role → model overrides (--model-<role>)
 * @returns {{complete: (req: {role: string, prompt: string, system?: string, model?: string}) => Promise<{text: string, usage: object, costUsd: number, model: string, role: string}>, modelForRole: (role: string) => string}}
 */
export function createAgentClient({ queryImpl = defaultQueryImpl, models, pricing, overrides = {} }) {
  /**
   * Resolves the model for a role: explicit per-call model > per-run
   * override > models.yaml role default.
   *
   * @param {string} role
   * @param {string} [explicitModel]
   */
  function resolveModel(role, explicitModel) {
    if (explicitModel) return explicitModel;
    if (overrides[role]) return overrides[role];
    const roleCfg = models.roles[role];
    if (!roleCfg) {
      throw new Error(`agentClient: unknown role "${role}" (known: ${Object.keys(models.roles).join(", ")})`);
    }
    return roleCfg.model;
  }

  return {
    modelForRole: (role) => resolveModel(role),

    async complete({ role, prompt, system, model }) {
      const resolved = resolveModel(role, model);
      const { text, usage } = await queryImpl({ prompt, system, model: resolved, role });
      const costUsd = costForModel(usage ?? {}, resolved, pricing);
      return { text, usage: usage ?? {}, costUsd, model: resolved, role };
    },
  };
}
