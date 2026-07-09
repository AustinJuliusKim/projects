/**
 * Fixture playback state machine: idle -> playing -> awaitingClient ->
 * playing -> done. Deterministic at speedMultiplier 0 (no setTimeout used
 * when the computed wait is 0).
 *
 * @typedef {import("@guided-repl/protocol").ServerFrame} ServerFrame
 * @typedef {import("@guided-repl/protocol").FixtureEnvelope} FixtureEnvelope
 * @typedef {import("@guided-repl/protocol").SnapshotManifest} SnapshotManifest
 * @typedef {"idle"|"playing"|"awaitingClient"|"awaitingStep"|"done"} PlayerState
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} opts
 * @param {FixtureEnvelope} opts.fixture
 * @param {SnapshotManifest} opts.snapshot
 * @param {number} opts.speedMultiplier
 * @param {boolean} [opts.stepMode]
 * @param {Record<number, {title?: string, body: string}>} [opts.annotationsByIndex]
 *   Anchored annotations from the lesson config (compiler-resolved event
 *   index → copy), merged with any in-fixture event.annotation.
 * @param {(frame: ServerFrame) => void} opts.onFrame
 * @param {(state: PlayerState) => void} opts.onStateChange
 * @param {(status: object) => void} [opts.onStatus]
 */
export function createFixturePlayer({
  fixture,
  snapshot,
  speedMultiplier,
  stepMode = false,
  annotationsByIndex,
  onFrame,
  onStateChange,
  onStatus,
}) {
  /** @type {PlayerState} */
  let state = "idle";
  let generation = 0;
  /** @type {((decision: string) => void)|null} */
  let pendingResolve = null;
  /** @type {(() => void)|null} */
  let pendingStepResolve = null;

  /** @param {PlayerState} next */
  function setState(next) {
    state = next;
    onStateChange(next);
  }

  /** Starts (or restarts) playback from the seed snapshot. */
  async function play() {
    const myGeneration = ++generation;
    setState("playing");

    const tree = { tree: snapshot.files.map((f) => ({ path: f.path, type: "file" })) };
    onFrame({ type: "file_tree", payload: { tree } });
    for (const f of snapshot.files) {
      if (myGeneration !== generation) return;
      onFrame({ type: "file_content", payload: { path: f.path, content: f.content } });
    }

    for (const [index, event] of fixture.events.entries()) {
      if (myGeneration !== generation) return;

      if ("awaitClient" in event) {
        const decisionPromise = new Promise((resolve) => {
          pendingResolve = resolve;
        });
        setState("awaitingClient");
        await decisionPromise;
        if (myGeneration !== generation) return;
        // Both approve and deny continue playback for MVP — tail branching
        // on the decision is out of scope.
        setState("playing");
        continue;
      }

      // In-fixture annotations (legacy L2 recordings) and config-anchored
      // annotations resolve to the same status; anchored ones also show in
      // auto playback (diegetic, non-blocking) while stepMode pauses both.
      const annotation = event.annotation ?? annotationsByIndex?.[index];
      if (annotation) {
        onStatus?.({ kind: "annotation", annotation });
      }
      if (stepMode && annotation) {
        // Promise created before setState, mirroring the awaitClient gate
        // above: interrupt() must be able to wake this coroutine even if it
        // races the setState/await below.
        const stepPromise = new Promise((resolve) => {
          pendingStepResolve = resolve;
        });
        setState("awaitingStep");
        await stepPromise;
        if (myGeneration !== generation) return;
        setState("playing");
      }

      const waitMs = event.delayMs * speedMultiplier;
      if (waitMs > 0) {
        await sleep(waitMs);
        if (myGeneration !== generation) return;
      }
      onFrame(event.frame);
    }

    if (myGeneration !== generation) return;
    setState("done");
  }

  /**
   * Resolves the parked awaitClient gate. Both "approve" and "deny" resume
   * playback (MVP: no tail branching on decision).
   *
   * @param {string} decision
   */
  function resolvePermission(decision) {
    if (state !== "awaitingClient" || !pendingResolve) return;
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(decision);
  }

  /**
   * Resolves the parked step gate, resuming playback past an annotated
   * event. No-op unless the player is currently awaitingStep.
   */
  function step() {
    if (state !== "awaitingStep" || !pendingStepResolve) return;
    const resolve = pendingStepResolve;
    pendingStepResolve = null;
    resolve();
  }

  /** Aborts any in-flight playback and returns to idle, re-emittable via play(). */
  function interrupt() {
    generation++;
    if (pendingResolve) {
      // Wake the parked play() coroutine so it exits via the generation guard.
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve("interrupted");
    }
    if (pendingStepResolve) {
      const resolve = pendingStepResolve;
      pendingStepResolve = null;
      resolve();
    }
    setState("idle");
  }

  /** Alias for interrupt() — resets to idle from any state. */
  function reset() {
    interrupt();
  }

  /** @returns {PlayerState} */
  function getState() {
    return state;
  }

  return { play, resolvePermission, step, interrupt, reset, getState };
}
