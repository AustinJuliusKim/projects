import { useCallback, useEffect, useReducer, useRef } from "react";
import { ClientMsg } from "@me/claude-repl-protocol";
import { reducer, initialState } from "./reducer.js";

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL || "/ws";

// Owns the WebSocket connection and exposes the reduced state + senders.
export function useSession() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef(null);

  useEffect(() => {
    dispatch({ type: "ws_connecting" });
    const url = WS_URL.startsWith("ws")
      ? WS_URL
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${WS_URL}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => dispatch({ type: "ws_open" });
    ws.onclose = () => dispatch({ type: "ws_closed" });
    ws.onmessage = (ev) => {
      try {
        dispatch(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => ws.close();
  }, []);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // BYOK: key is sent over the (W)SS connection and never stored beyond the
  // browser session. sessionStorage is cleared when the tab closes.
  const setKey = useCallback(
    (key) => {
      sessionStorage.setItem("anthropic_key_present", "1");
      send({ type: ClientMsg.SET_KEY, key });
      dispatch({ type: "key_submitted" });
    },
    [send],
  );

  const setMode = useCallback(
    (mode) => {
      send({ type: ClientMsg.SET_MODE, mode });
      dispatch({ type: "set_mode", mode });
    },
    [send],
  );

  const prompt = useCallback(
    (text) => {
      send({ type: ClientMsg.PROMPT, text });
      dispatch({ type: "prompt_sent", text });
    },
    [send],
  );

  const approve = useCallback((id) => send({ type: ClientMsg.APPROVE, id }), [send]);
  const deny = useCallback((id, reason) => send({ type: ClientMsg.DENY, id, reason }), [send]);
  const interrupt = useCallback(() => send({ type: ClientMsg.INTERRUPT }), [send]);
  const openFile = useCallback((path) => dispatch({ type: "open_file", path }), []);

  return { state, setKey, setMode, prompt, approve, deny, interrupt, openFile };
}
