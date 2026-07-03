/**
 * Computes replay pacing for a sequence of timestamped frames.
 */

/**
 * @typedef {{frame: import("@guided-repl/protocol").ServerFrame, tMs: number}} TimedFrame
 * @typedef {{frame: import("@guided-repl/protocol").ServerFrame, delayMs: number, origDelayMs: number}} PacedEvent
 */

const CAP_MS = 1500;

/**
 * Given a chronological list of {frame, tMs}, returns {frame, delayMs,
 * origDelayMs} entries: `origDelayMs` is the uncapped gap to the previous
 * frame (0 for the first), `delayMs` is that gap capped at 1500ms and
 * floored at 0.
 *
 * @param {TimedFrame[]} entries
 * @returns {PacedEvent[]}
 */
export function computePacing(entries) {
  let prevT = null;
  return entries.map(({ frame, tMs }) => {
    const origDelayMs = prevT === null ? 0 : Math.max(0, tMs - prevT);
    const delayMs = Math.min(origDelayMs, CAP_MS);
    prevT = tMs;
    return { frame, delayMs, origDelayMs };
  });
}
