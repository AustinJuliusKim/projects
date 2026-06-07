import React, { useEffect, useRef, useState } from "react";
import { getGame, eliminate } from "./api.js";
import { loadIdentity, saveIdentity } from "./storage.js";
import { enablePush, pushSupported, isIosSafari, isStandalone } from "./push.js";
import { stashActiveGame } from "./resume.js";

const POLL_MS = 3000;

export default function PlayView({ gameId, inviteToken }) {
  const [identity, setIdentity] = useState(() => loadIdentity(gameId));
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pushPrompted, setPushPrompted] = useState(false);
  const pollRef = useRef(null);

  // Claim role B from the invite token on first open (if not already identified).
  useEffect(() => {
    if (!identity && inviteToken) {
      const id = { role: "B", token: inviteToken };
      saveIdentity(gameId, "B", inviteToken);
      setIdentity(id);
    }
  }, [gameId, inviteToken, identity]);

  // Bridge identity to Cache Storage so an iOS Home Screen install can recover
  // this game (separate localStorage + start_url reset). Best-effort.
  useEffect(() => {
    if (identity) {
      stashActiveGame({ gameId, role: identity.role, token: identity.token });
    }
  }, [gameId, identity]);

  // Initial load + polling loop.
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const { state } = await getGame(gameId);
        if (alive) setState(state);
      } catch (err) {
        if (alive) setError(err.message);
      }
    }
    poll();
    pollRef.current = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(pollRef.current);
    };
  }, [gameId]);

  // Offer push once we know who we are (and the game is still active).
  useEffect(() => {
    if (
      identity &&
      state?.status === "active" &&
      pushSupported() &&
      !pushPrompted &&
      (!isIosSafari() || isStandalone())
    ) {
      setPushPrompted(true);
      enablePush(gameId, identity.role, identity.token).catch(() => {});
    }
  }, [identity, state, gameId, pushPrompted]);

  async function onEliminate(index) {
    if (!identity) return;
    setBusy(true);
    setError(null);
    try {
      const { state } = await eliminate(gameId, identity.role, identity.token, index);
      setState(state);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !state) {
    return (
      <div className="container">
        <h1>Hmm…</h1>
        <p className="error">{error}</p>
        <a className="btn ghost" href="#/">
          Start a new game
        </a>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="container">
        <p className="muted">Loading game…</p>
      </div>
    );
  }

  const eliminatedSet = new Set(state.eliminated.map((e) => e.index));
  const myTurn = identity && state.status === "active" && state.turn === identity.role;
  const complete = state.status === "complete";

  return (
    <div className="container">
      <h1>{complete ? "We have a winner! 🏆" : "Eliminate a choice"}</h1>

      {!complete && (
        <div className={`banner ${myTurn ? "your-turn" : "waiting"}`}>
          {!identity
            ? "Spectating — open the invite link to play."
            : myTurn
            ? "Your turn — tap a choice to eliminate it."
            : `Waiting for player ${state.turn}…`}
        </div>
      )}

      <ul className="choices">
        {state.choices.map((label, i) => {
          const dead = eliminatedSet.has(i);
          const isWinner = complete && state.winnerIndex === i;
          return (
            <li
              key={i}
              className={`choice ${dead ? "dead" : ""} ${isWinner ? "winner" : ""}`}
            >
              <button
                className="choice-btn"
                disabled={!myTurn || dead || busy}
                onClick={() => onEliminate(i)}
              >
                <span className="label">{label}</span>
                {dead && <span className="tag">eliminated</span>}
                {isWinner && <span className="tag win">winner</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {error && <p className="error">{error}</p>}

      {isIosSafari() && !isStandalone() && !complete && (
        <p className="hint">
          📲 On iPhone? Tap Share → <strong>Add to Home Screen</strong>, then
          open the app from your Home Screen. Your game will be waiting there and
          you'll get a buzz when it's your turn.
        </p>
      )}

      {complete && (
        <a className="btn primary" href="#/">
          {identity?.role === "B" ? "🎲 Start a new game" : "🔁 Play again"}
        </a>
      )}
    </div>
  );
}
