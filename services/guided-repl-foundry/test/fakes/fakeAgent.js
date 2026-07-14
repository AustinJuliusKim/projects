/**
 * Fake AgentClient queryImpl for keyless tests: records every request and
 * returns canned responses — by role queue first, then the shared queue,
 * else a deterministic default.
 */

export const DEFAULT_FAKE_USAGE = { input_tokens: 1000, output_tokens: 500 };

/**
 * @param {object} [opts]
 * @param {(string | {text: string, usage?: object})[]} [opts.responses] shared FIFO queue
 * @param {Record<string, (string | {text: string, usage?: object})[]>} [opts.byRole] per-role FIFO queues (take priority)
 * @returns {{queryImpl: import("../../src/agent/agentClient.js").QueryImpl, calls: object[]}}
 */
export function createFakeAgent({ responses = [], byRole = {} } = {}) {
  const shared = [...responses];
  const roleQueues = Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, [...v]]));
  const calls = [];

  async function queryImpl(req) {
    calls.push({ ...req });
    const queue = req.role && roleQueues[req.role]?.length ? roleQueues[req.role] : shared;
    const next = queue.length > 0 ? queue.shift() : `fake response ${calls.length}`;
    const normalized = typeof next === "string" ? { text: next } : next;
    return { text: normalized.text, usage: normalized.usage ?? { ...DEFAULT_FAKE_USAGE } };
  }

  return { queryImpl, calls };
}
