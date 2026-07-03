/**
 * E2B-backed Runner. Not configured in this environment (no E2B API key /
 * CLI available). Slots in behind the same Runner interface as
 * `localRunner.js` once E2B is set up.
 *
 * @implements {import("./runner.js").Runner}
 */

/**
 * @param {import("./runner.js").RunnerOptions} _opts
 * @returns {AsyncIterable<object>}
 */
export function run(_opts) {
  throw new Error("E2B runner not configured");
}
