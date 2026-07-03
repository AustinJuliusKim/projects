/**
 * React hook wiring a transport into the reducer. Return shape is frozen —
 * downstream components must not depend on anything beyond it.
 *
 * @typedef {object} UseSessionOpts
 * @property {"guided"|"byok"|"wallet"} mode
 * @property {object} [lesson]
 * @property {Array<object>} [branches]
 * @property {number} [speedMultiplier]
 * @property {() => void} [onDone]
 *
 * @typedef {object} UseSessionResult
 * @property {import("./reducer.js").SessionState} state
 * @property {(text: string) => void} prompt
 * @property {() => void} approve
 * @property {() => void} deny
 * @property {() => void} interrupt
 * @property {(path: string) => void} openFile
 * @property {() => void} next
 */

import { useReducer, useRef, useEffect, useCallback } from "react";
import { reducer, createInitialState } from "./reducer.js";
import { createTransport } from "./transport.js";

/**
 * @param {UseSessionOpts} opts
 * @returns {UseSessionResult}
 */
export function useSession({ mode, lesson, branches, speedMultiplier, onDone }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const transportRef = useRef(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const transport = createTransport(mode, {
      branches,
      snapshot: lesson?.snapshot,
      speedMultiplier,
      stepMode: lesson?.playback === "step",
    });
    transportRef.current = transport;

    transport.connect({
      onFrame: (frame) => {
        dispatch(frame);
        if (frame.type === "done" && onDoneRef.current) {
          onDoneRef.current();
        }
      },
      onStatus: (status) => {
        if (status?.kind === "hint") {
          dispatch({ type: "hint_shown", hint: status });
        }
        if (status?.kind === "annotation") {
          dispatch({ type: "annotation_shown", annotation: status.annotation });
        }
      },
    });

    return () => transport.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, lesson, branches, speedMultiplier]);

  const prompt = useCallback((text) => {
    dispatch({ type: "prompt_sent", text });
    transportRef.current?.send({ type: "prompt", text });
  }, []);

  const approve = useCallback(() => {
    dispatch({ type: "permission_resolved", decision: "approve" });
    transportRef.current?.send({ type: "permission", decision: "approve" });
  }, []);

  const deny = useCallback(() => {
    dispatch({ type: "permission_resolved", decision: "deny" });
    transportRef.current?.send({ type: "permission", decision: "deny" });
  }, []);

  const interrupt = useCallback(() => {
    dispatch({ type: "reset" });
    transportRef.current?.send({ type: "interrupt" });
  }, []);

  const openFile = useCallback((path) => {
    dispatch({ type: "open_file", path });
  }, []);

  // Clearing the annotation is driven from here (rather than implicitly on
  // the next frame arriving) so a step-mode UI can dismiss the annotation
  // card the instant the user advances, without waiting on playback timing.
  const next = useCallback(() => {
    dispatch({ type: "annotation_cleared" });
    transportRef.current?.send({ type: "next" });
  }, []);

  return { state, prompt, approve, deny, interrupt, openFile, next };
}
