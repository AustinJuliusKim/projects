/**
 * Semantic anchor resolution: maps an authored anchor selector to the index
 * of a concrete fixture event. Shared by the lessons compiler (stamps
 * resolvedEventIndex at build), CI checks (detects re-seed drift), and the
 * app (annotation placement).
 *
 * @typedef {{ordinal: number, frameType: string, where?: {tool?: string, pathIncludes?: string}}} SemanticAnchor
 * @typedef {import("./fixtureFormat.js").FixtureEvent} FixtureEvent
 */

/**
 * @param {SemanticAnchor} anchor
 * @param {FixtureEvent} event
 * @returns {boolean}
 */
function eventMatches(anchor, event) {
  if (!("frame" in event) || event.frame?.type !== anchor.frameType) return false;
  const where = anchor.where;
  if (!where) return true;
  const payload = event.frame.payload ?? {};
  if (where.tool !== undefined && payload.tool !== where.tool) return false;
  if (where.pathIncludes !== undefined) {
    // tool_use carries the path inside input; file_content carries it at the top level.
    const path = payload.input?.file_path ?? payload.input?.path ?? payload.path;
    if (typeof path !== "string" || !path.includes(where.pathIncludes)) return false;
  }
  return true;
}

/**
 * Resolves an anchor against a fixture's event list.
 *
 * @param {SemanticAnchor} anchor
 * @param {FixtureEvent[]} events
 * @returns {number|null} index of the ordinal-th matching event, or null
 */
export function resolveAnchor(anchor, events) {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (eventMatches(anchor, events[i])) {
      seen += 1;
      if (seen === anchor.ordinal) return i;
    }
  }
  return null;
}
