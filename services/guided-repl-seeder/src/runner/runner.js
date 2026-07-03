/**
 * Runner interface: something that can drive a Claude Code agent session
 * and yield raw NDJSON stream events. Implementations: `localRunner.js`
 * (M2, spawns `claude -p ... --output-format stream-json`), `e2bRunner.js`
 * (stub, later).
 *
 * @typedef {object} RunnerOptions
 * @property {string} prompt
 * @property {string} cwd
 * @property {string} permissionMode
 * @property {string} [model] optional `--model` override; omitted uses the session default
 *
 * @typedef {object} Runner
 * @property {(opts: RunnerOptions) => AsyncIterable<object>} run
 *   Runs the given prompt against a Claude Code session rooted at `cwd` with
 *   the given `permissionMode`, yielding raw NDJSON objects as parsed from
 *   the agent's stream-json output, one per emitted line.
 */

export {};
