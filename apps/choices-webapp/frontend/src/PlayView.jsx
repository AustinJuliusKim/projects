import React, { useEffect, useRef, useState } from "react";
import { getState, eliminate, rematch } from "./api.js";
import { clearIdentity } from "./storage.js";
import { enablePush, pushSupported, isIosSafari, isStandalone } from "./push.js";

const POLL_MS = 3000;

export default function PlayView({ identity, onLeave }) {
  const { pairingId, role, token } = identity;
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [bumped, setBumped] = useState(false);
  const [pushPrompted, setPushPrompted] = useState(false);
  const [rematchChoices, setRematchChoices] = useState(["", "", "", ""]);
  const pollRef = useRef(null);

  // If this device's token was taken over by another device, sign out cleanly.
  function isBumped(err) {
    return err?.status === 403 && err?.code === "BAD_TOKEN";
  }

  // Initial load + polling (foreground fallback; push is primary on iOS).
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await getState(pairingId, role, token);
        if (alive) setState(res.state);
      } catch (err) {
        if (!alive) return;
        if (isBumped(err)) setBumped(true);
        else setError(err.message);
      }
    }
    poll();
    pollRef.current = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(pollRef.current);
    };
  }, [pairingId, role, token]);

  // Offer push once (only meaningful inside an installed app on iOS).
  useEffect(() => {
    if (
      state &&
      pushSupported() &&
      !pushPrompted &&
      (!isIosSafari() || isStandalone())
    ) {
      setPushPrompted(true);
      enablePush(pairingId, role, token).catch(() => {});
    }
  }, [state, pairingId, role, token, pushPrompted]);

  async function onEliminate(index) {
    setBusy(true);
    setError(null);
    try {
      const res = await eliminate(pairingId, role, token, state.gameNumber, index);
      setState(res.state);
    } catch (err) {
      if (isBumped(err)) setBumped(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRematch(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await rematch(
        pairingId,
        role,
        token,
        rematchChoices.map((c) => c.trim())
      );
      setState(res.state);
      setRematchChoices(["", "", "", ""]);
    } catch (err) {
      if (isBumped(err)) setBumped(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function leaveGame() {
    clearIdentity();
    window.location.hash = "";
    if (onLeave) onLeave();
  }

  if (bumped) {
    return (
      <div className="container">
        <h1>Signed out</h1>
        <p className="muted">
          This player seat was claimed on another device. Re-enter the code to
          take it back, or join as the other player.
        </p>
        <button className="btn primary" onClick={leaveGame}>
          Back to start
        </button>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="container">
        <h1>Hmm…</h1>
        <p className="error">{error}</p>
        <button className="btn ghost" onClick={leaveGame}>
          Leave game
        </button>
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

  const game = state.game;
  const eliminatedSet = new Set(game.eliminated.map((e) => e.index));
  const myTurn = game.status === "active" && game.turn === role;
  const complete = game.status === "complete";
  const iCanRematch = complete && state.nextStarter === role;
  const other = role === "A" ? "B" : "A";

  return (
    <div className="container">
      <h1>{complete ? "We have a winner! 🏆" : "Eliminate a choice"}</h1>

      {!state.bothJoined && (
        <div className="banner waiting">
          Share code <strong>{state.code}</strong> with your opponent to begin.
        </div>
      )}

      {!complete && state.bothJoined && (
        <div className={`banner ${myTurn ? "your-turn" : "waiting"}`}>
          {myTurn
            ? "Your turn — tap a choice to eliminate it."
            : `Waiting for player ${game.turn}…`}
        </div>
      )}

      <ul className="choices">
        {game.choices.map((label, i) => {
          const dead = eliminatedSet.has(i);
          const isWinner = complete && game.winnerIndex === i;
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

      {complete && iCanRematch && (
        <form className="rematch" onSubmit={onRematch}>
          <h2>Start the next game</h2>
          <p className="muted">
            Pick 4 new choices. Player {other} eliminates first.
          </p>
          {rematchChoices.map((c, i) => (
            <input
              key={i}
              className="choice-input"
              placeholder={`Choice ${i + 1}`}
              value={c}
              maxLength={60}
              onChange={(e) =>
                setRematchChoices((cs) =>
                  cs.map((x, j) => (j === i ? e.target.value : x))
                )
              }
            />
          ))}
          <button
            className="btn primary"
            type="submit"
            disabled={busy || rematchChoices.some((c) => !c.trim())}
          >
            {busy ? "Starting…" : "🎲 Start new game"}
          </button>
        </form>
      )}

      {complete && !iCanRematch && (
        <div className="banner waiting">
          Waiting for player {state.nextStarter} to start the next game…
        </div>
      )}

      {isIosSafari() && !isStandalone() && (
        <p className="hint">
          📲 On iPhone? Tap Share → <strong>Add to Home Screen</strong>, then open
          the app from your Home Screen so you get a buzz when it's your turn.
        </p>
      )}

      <div className="footer">
        <span className="muted">You are Player {role}</span>
        <button className="link-btn" onClick={leaveGame}>
          Leave / switch player
        </button>
      </div>
    </div>
  );
}
