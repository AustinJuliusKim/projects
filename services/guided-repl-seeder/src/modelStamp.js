/**
 * Usage-model attribution: captures the real model id Claude Code reports
 * on its `system/init` raw event, and stamps it onto the paced fixture's
 * terminal `usage` frame(s) — never hardcode a model id into a fixture,
 * always thread the one the live stream actually reported.
 */

/**
 * Inspects one raw NDJSON event (as yielded by the Runner, pre-mapping) and
 * returns the model id if this is a `system/init` event carrying one.
 *
 * @param {object} raw
 * @returns {string | undefined}
 */
export function captureModelFromRaw(raw) {
  if (raw && typeof raw === "object" && raw.type === "system" && raw.subtype === "init") {
    return typeof raw.model === "string" && raw.model.length > 0 ? raw.model : undefined;
  }
  return undefined;
}

/**
 * Returns a new events array with `payload.model` set on every `usage`
 * frame, given a captured model id. A no-op (returns `events` unchanged)
 * when `model` is falsy.
 *
 * @param {import("@guided-repl/protocol").FixtureEvent[]} events
 * @param {string | undefined} model
 * @returns {import("@guided-repl/protocol").FixtureEvent[]}
 */
export function stampUsageModel(events, model) {
  if (!model) return events;
  return events.map((e) => {
    if ("frame" in e && e.frame.type === "usage") {
      return { ...e, frame: { ...e.frame, payload: { ...e.frame.payload, model } } };
    }
    return e;
  });
}
