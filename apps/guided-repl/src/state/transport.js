/**
 * Transport factory + interface. `useSession` holds a transport behind this
 * seam so the reducer/components never branch on mode.
 *
 * @typedef {object} TransportHandlers
 * @property {(frame: import("@guided-repl/protocol").ServerFrame) => void} onFrame
 * @property {(status: object) => void} [onStatus]
 *
 * @typedef {object} Transport
 * @property {(handlers: TransportHandlers) => void} connect
 * @property {(msg: object) => void} send
 * @property {() => void} close
 */

import { fixtureTransport } from "./fixtureTransport.js";

/**
 * `opts` is forwarded wholesale to the underlying transport, including
 * `stepMode` and per-branch `snapshot` entries — this factory has no
 * per-field knowledge, so guided-mode additions (fixtureTransport) reach
 * their opts without any change needed here.
 *
 * @param {"guided"|"byok"|"wallet"} mode
 * @param {object} opts
 * @returns {Transport}
 */
export function createTransport(mode, opts) {
  if (mode === "guided") {
    return fixtureTransport(opts);
  }
  if (mode === "byok" || mode === "wallet") {
    return liveTransport(opts);
  }
  throw new Error(`Unknown transport mode: ${mode}`);
}

/**
 * Stub for Phase B (live WebSocket transport, extracted verbatim from the
 * original inline `new WebSocket` per architecture §2).
 *
 * @param {object} _opts
 * @returns {Transport}
 */
function liveTransport(_opts) {
  return {
    connect(handlers) {
      handlers.onStatus?.({ kind: "idle" });
    },
    send() {
      throw new Error("liveTransport is not implemented yet");
    },
    close() {},
  };
}
