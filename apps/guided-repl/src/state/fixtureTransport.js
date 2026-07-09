/**
 * Guided-mode transport: wraps a fixturePlayer. send() never transmits —
 * it matches the outgoing client message against the loaded branch set and,
 * on match, resumes frame playback.
 *
 * @typedef {import("./transport.js").Transport} Transport
 * @typedef {import("./transport.js").TransportHandlers} TransportHandlers
 * @typedef {{branchId: string, expectedPrompt: string, fixture: import("@guided-repl/protocol").FixtureEnvelope, snapshot?: import("@guided-repl/protocol").SnapshotManifest}} FixtureBranch
 */

import { matchPrompt } from "../player/matchPrompt.js";
import { createFixturePlayer } from "../player/fixturePlayer.js";

/**
 * @param {object} opts
 * @param {FixtureBranch[]} opts.branches
 * @param {import("@guided-repl/protocol").SnapshotManifest} opts.snapshot
 * @param {number} [opts.speedMultiplier]
 * @param {boolean} [opts.stepMode]
 * @param {Record<string, Record<number, object>>} [opts.annotations] anchored annotations, keyed by branchId → event index
 * @returns {Transport}
 */
export function fixtureTransport({ branches, snapshot, speedMultiplier = 1, stepMode = false, annotations }) {
  /** @type {TransportHandlers|null} */
  let handlers = null;
  /** @type {ReturnType<typeof createFixturePlayer>|null} */
  let player = null;

  /** @param {TransportHandlers} h */
  function connect(h) {
    handlers = h;
    handlers.onStatus?.({ kind: "idle" });
  }

  /** @param {object} msg */
  function send(msg) {
    if (!handlers) return;

    switch (msg.type) {
      case "prompt": {
        // Explicit branchId (composer suggestions, drill transcripts) takes
        // precedence — it disambiguates branches that share an
        // expectedPrompt (l4/l5/l7/l8 counterfactuals). Prompt matching is
        // the fallback for plain typed text.
        const match = msg.branchId
          ? branches.some((b) => b.branchId === msg.branchId) && { branchId: msg.branchId }
          : matchPrompt(msg.text, branches);
        if (!match) {
          handlers.onStatus({ kind: "hint", text: msg.text });
          return;
        }
        const branch = branches.find((b) => b.branchId === match.branchId);
        player = createFixturePlayer({
          fixture: branch.fixture,
          // Additive fallback: fall back to the lesson-level snapshot when
          // the matched branch has none (e.g. lessons authored pre-L7).
          snapshot: branch.snapshot ?? snapshot,
          speedMultiplier,
          stepMode,
          annotationsByIndex: annotations?.[match.branchId],
          onFrame: (frame) => handlers.onFrame(frame),
          onStateChange: (state) => handlers.onStatus?.({ kind: "player_state", state }),
          onStatus: (status) => handlers.onStatus?.(status),
        });
        player.play();
        return;
      }

      case "permission": {
        player?.resolvePermission(msg.decision);
        return;
      }

      case "next": {
        player?.step();
        return;
      }

      case "interrupt": {
        player?.interrupt();
        return;
      }

      default:
        return;
    }
  }

  function close() {
    player?.interrupt();
    player = null;
    handlers = null;
  }

  return { connect, send, close };
}
