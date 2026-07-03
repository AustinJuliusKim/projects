import React, { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { getState, eliminate, rematch, linkClick } from "./api.js";
import { PLATFORMS } from "./affiliates.js";
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

  // Winner-reveal card flip. `complete` is computed before the early returns
  // so the hooks below can depend on it (hooks rule).
  const complete = state?.game?.status === "complete";
  const sceneRef = useRef(null); // confetti origin
  const prevCompleteRef = useRef(null); // null = no snapshot yet (fresh load)
  const lastWinnerRef = useRef(null); // keeps back face populated during flip-back
  const [animateFlip, setAnimateFlip] = useState(false); // stays false when loading into an already-complete game
  const [settled, setSettled] = useState(false); // post-flip: drop front face from layout

  useEffect(() => {
    if (state?.game?.status === "active") setAnimateFlip(true);
  }, [state]);

  // Confetti only on an observed active -> complete transition, timed to the
  // flip landing (250ms delay + 600ms flip).
  useEffect(() => {
    if (!state) return;
    const was = prevCompleteRef.current;
    prevCompleteRef.current = complete;
    if (!(complete && was === false)) return;
    const t = setTimeout(() => {
      const r = sceneRef.current?.getBoundingClientRect();
      confetti({
        particleCount: 90,
        spread: 70,
        startVelocity: 35,
        colors: ["#4f46e5", "#22c55e"],
        disableForReducedMotion: true,
        origin: r
          ? {
              x: (r.left + r.width / 2) / window.innerWidth,
              y: (r.top + r.height * 0.35) / window.innerHeight,
            }
          : { y: 0.4 },
      });
    }, 850);
    return () => clearTimeout(t);
  }, [state, complete]);

  useEffect(() => {
    if (!complete) {
      setSettled(false);
      return;
    }
    if (!animateFlip) {
      setSettled(true); // loaded already-complete: no animation to wait for
      return;
    }
    const t = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(t);
  }, [complete, animateFlip]);

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

  // Fire-and-forget click beacon — never block or delay the outbound link.
  function reportLinkClick(platform) {
    linkClick(pairingId, role, token, state.gameNumber, platform).catch(() => {});
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
  const iCanRematch = complete && state.nextStarter === role;
  const other = role === "A" ? "B" : "A";

  // winnerIndex resets to null the moment a rematch starts; keep the last
  // winner rendered on the back face while it flips away.
  if (complete) lastWinnerRef.current = game.choices[game.winnerIndex];
  const winnerName = complete ? game.choices[game.winnerIndex] : lastWinnerRef.current;

  return (
    <div className="container">
      <h1 key={complete ? "won" : "play"} className="fade-swap">
        {complete ? "We have a winner! 🏆" : "Cut a choice"}
      </h1>

      {!state.bothJoined && (
        <div className="banner waiting">
          Share code <strong>{state.code}</strong> with your opponent to begin.
        </div>
      )}

      {!complete && state.bothJoined && (
        <div className={`banner ${myTurn ? "your-turn" : "waiting"}`}>
          {myTurn
            ? "Your turn — tap a choice to cut it."
            : `Waiting for player ${game.turn}…`}
        </div>
      )}

      <div className="flip-scene" ref={sceneRef}>
        <div
          className={`flip-card ${complete ? "flipped" : ""} ${
            animateFlip ? "" : "no-anim"
          } ${settled ? "flip-settled" : ""}`}
        >
          <div className="flip-face flip-front" aria-hidden={complete}>
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
                      {dead && <span className="tag">cut</span>}
                      {isWinner && <span className="tag win">winner</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div
            className="flip-face flip-back"
            aria-hidden={!complete}
            inert={!complete ? "" : undefined}
          >
            {winnerName != null && (
              <div className="get-winner">
                <h2 className="reveal" style={{ "--d": "550ms" }}>
                  Get {winnerName}
                </h2>
                <div className="platform-btns reveal" style={{ "--d": "650ms" }}>
                  {PLATFORMS.map((p) => (
                    <a
                      key={p.id}
                      className="btn platform"
                      style={{ "--brand": p.brandColor }}
                      href={p.buildUrl(winnerName)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => reportLinkClick(p.id)}
                    >
                      {p.iconPath ? (
                        <svg
                          className="platform-icon"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path d={p.iconPath} />
                        </svg>
                      ) : (
                        <span className="platform-icon monogram" aria-hidden="true">
                          {p.monogram}
                        </span>
                      )}
                      <span className="platform-label">{p.label}</span>
                    </a>
                  ))}
                </div>
                <p className="disclosure muted reveal" style={{ "--d": "750ms" }}>
                  We may earn a commission from these links.
                  <br />
                  Not affiliated with or endorsed by these platforms.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {complete && iCanRematch && (
        <form className="rematch" onSubmit={onRematch}>
          <h2>Start the next game</h2>
          <p className="muted">
            Pick 4 new choices. Player {other} cuts first.
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
