import React, { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { getState, eliminate, rematch, linkClick, getPairHistory, fillMyFour, track } from "@/lib/api.js";
import { authEnabled } from "@/lib/auth.js";
import { useMe } from "@/hooks/useMe.js";
import PlayViewSkeleton from "@/features/game/PlayViewSkeleton.jsx";
import { drawRevealCard } from "@/features/game/revealCard.js";
import WinnerFace from "@/features/game/WinnerFace.jsx";
import NewGameScreen from "@/features/game/NewGameScreen.jsx";
import { PinnedInvite, GameCodeLine } from "@/features/game/GameCode.jsx";
import Button from "@/components/Button.jsx";
import { clearIdentity } from "@/lib/storage.js";
import { enablePush, pushSupported, isIosSafari, isStandalone } from "@/lib/push.js";
import { isNative } from "@/lib/platform.js";

// Adaptive polling (foreground fallback; push is primary). The interval
// tracks how hot the game is; hidden tabs stop polling entirely and refetch
// immediately on return (which also covers notification taps).
const POLL_MS = {
  hot: 3000, // opponent's move lands any second (or state not loaded yet)
  waiting: 15000, // waiting for the opponent to join — push nudges the host
  idle: 30000, // my turn / game complete — remote changes are rare
};
const POLL_ERROR_MAX_MS = 60000;

export default function PlayView({ identity, onLeave }) {
  const { pairingId, role, token } = identity;
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [bumped, setBumped] = useState(false);
  const [pushPrompted, setPushPrompted] = useState(false);
  const [rematchChoices, setRematchChoices] = useState(["", "", "", ""]);

  // Premium perk: signed-in premium players may start the next game out of
  // turn, so the rematch form needs the account's premium status. Shares the
  // getMe cache with every other view — guests never grow an auth call.
  const { me: meForPremium } = useMe();
  const premium = ["active", "past_due"].includes(meForPremium?.premium?.status);

  // Winner-reveal card flip. `complete` (and `iCanRematch`, which hooks also
  // depend on) is computed before the early returns (hooks rule).
  const complete = state?.game?.status === "complete";
  const iCanRematch = complete && (state?.nextStarter === role || premium);
  const sceneRef = useRef(null); // confetti origin
  const prevCompleteRef = useRef(null); // null = no snapshot yet (fresh load)
  const lastWinnerRef = useRef(null); // keeps back face populated during flip-back
  const [animateFlip, setAnimateFlip] = useState(false); // stays false when loading into an already-complete game
  const [settled, setSettled] = useState(false); // post-flip: drop front face from layout
  const [rematchRevealed, setRematchRevealed] = useState(false); // 2nd flip: winner card -> next-game form on the front face

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
      if (isNative) {
        Haptics.notification({ type: NotificationType.Success }).catch(() => {});
      }
      const r = sceneRef.current?.getBoundingClientRect();
      const theme = getComputedStyle(document.documentElement);
      confetti({
        particleCount: 90,
        spread: 70,
        startVelocity: 35,
        colors: [
          theme.getPropertyValue("--indigo").trim(),
          theme.getPropertyValue("--winner").trim(),
        ],
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

  // Reset the 2nd-flip state whenever we're not on a completed game (e.g. the
  // next game just started), so the card returns to the board cleanly.
  useEffect(() => {
    if (!complete) setRematchRevealed(false);
  }, [complete]);

  // If this device's token was taken over by another device, sign out cleanly.
  function isBumped(err) {
    return err?.status === 403 && err?.code === "BAD_TOKEN";
  }

  // Poll mode derives from the latest state, so mutations retune the poll
  // rate instantly (e.g. after my cut it's the opponent's turn -> hot).
  const pollMode = !state
    ? "hot"
    : !state.bothJoined
      ? "waiting"
      : state.game.status === "active" && state.game.turn !== role
        ? "hot"
        : "idle";

  // Initial load + adaptive polling; the effect re-arms whenever pollMode
  // changes. Self-scheduling setTimeout (not setInterval) so each delay is
  // recomputed, backs off on errors, and pauses while the tab is hidden.
  useEffect(() => {
    let alive = true;
    let timer = null;
    let errorStreak = 0;

    async function poll() {
      timer = null;
      try {
        const res = await getState(pairingId, role, token);
        if (!alive) return;
        errorStreak = 0;
        setState(res.state);
      } catch (err) {
        if (!alive) return;
        if (isBumped(err)) {
          setBumped(true);
          return; // seat lost — stop polling
        }
        errorStreak += 1;
        setError(err.message);
      }
      schedule();
    }

    function schedule() {
      if (!alive || document.visibilityState === "hidden") return;
      const base = Math.min(
        POLL_MS[pollMode] * 2 ** errorStreak,
        POLL_ERROR_MAX_MS
      );
      // ±20% jitter desynchronizes the two players' clients
      timer = setTimeout(poll, base * (0.8 + Math.random() * 0.4));
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (timer == null) {
        poll(); // back in the foreground: refetch now, then reschedule
      }
    }

    poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pairingId, role, token, pollMode]);

  // reveal_viewed: once per completed game (per mount) when the winner face
  // renders. Approximate by design — a reload re-reports, dedupe is a
  // query-side concern.
  const revealTrackedRef = useRef(null);
  useEffect(() => {
    if (!complete || !state) return;
    if (revealTrackedRef.current === state.game.number) return;
    revealTrackedRef.current = state.game.number;
    track("reveal_viewed", { game_number: state.game.number }, { pairingId, role, token });
  }, [complete, state, pairingId, role, token]);

  // Pair memory (suggestion engine L1) for the rematch typeahead: fetched
  // once, only when the rematch form first becomes visible — never on the
  // poll path.
  const [pairEntries, setPairEntries] = useState([]);
  const histFetchedRef = useRef(false);
  useEffect(() => {
    if (!iCanRematch || histFetchedRef.current) return;
    histFetchedRef.current = true;
    getPairHistory(pairingId, role, token)
      .then((res) => setPairEntries(res.entries ?? []))
      .catch(() => {});
  }, [iCanRematch, pairingId, role, token]);

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
    if (isNative) Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
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

  // Whether the current rematch 4 came from "Fill my 4" (event provenance).
  const rematchFilledRef = useRef(false);

  async function onRematch(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await rematch(
        pairingId,
        role,
        token,
        rematchChoices.map((c) => c.trim()),
        rematchFilledRef.current ? "fill4" : undefined
      );
      setState(res.state);
      setRematchChoices(["", "", "", ""]);
      rematchFilledRef.current = false;
    } catch (err) {
      if (isBumped(err)) setBumped(true);
      else if (err.code === "GAME_IN_PROGRESS") {
        // Both players hit restart at once and the other one won — their new
        // game is the real state now, so sync to it instead of erroring.
        getState(pairingId, role, token)
          .then((res) => setState(res.state))
          .catch(() => {});
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Fire-and-forget click beacon — never block or delay the outbound link.
  function reportLinkClick(platform) {
    linkClick(pairingId, role, token, state.gameNumber, platform).catch(() => {});
  }

  // Reveal card share (growth §8 channel #1). Canvas -> native share sheet
  // (Capacitor), web share sheet, or a plain download — whichever this
  // device supports.
  async function onShareReveal() {
    reportLinkClick("share-reveal");
    const canvas = document.createElement("canvas");
    await drawRevealCard(canvas, {
      winner: winnerName,
      losers: game.choices.filter((_, i) => i !== game.winnerIndex),
    });
    if (isNative) {
      try {
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const { Share } = await import("@capacitor/share");
        const file = await Filesystem.writeFile({
          path: "choices-reveal.png",
          data: canvas.toDataURL("image/png").split(",")[1],
          directory: Directory.Cache,
        });
        await Share.share({ title: "Choices", files: [file.uri] });
      } catch {
        /* sheet dismissed */
      }
      return;
    }
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return;
    const file = new File([blob], "choices-reveal.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch {
        /* cancelled -> fall through to download */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "choices-reveal.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Native shell: target="_blank" handling in WKWebView is unreliable — open
  // outbound links in SFSafariViewController (user stays in the app,
  // affiliate redirect chains work).
  function onPlatformClick(e, p) {
    reportLinkClick(p.id);
    if (isNative) {
      e.preventDefault();
      import("@capacitor/browser").then(({ Browser }) =>
        Browser.open({ url: p.buildUrl(winnerName) }).catch(() => {})
      );
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
        <Button variant="primary" onClick={leaveGame}>
          Back to start
        </Button>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="container">
        <h1>Hmm…</h1>
        <p className="error">{error}</p>
        <Button variant="ghost" onClick={leaveGame}>
          Leave game
        </Button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="container" aria-busy="true">
        <PlayViewSkeleton />
      </div>
    );
  }

  const game = state.game;
  const eliminatedSet = new Set(game.eliminated.map((e) => e.index));
  const myTurn = game.status === "active" && game.turn === role;
  const other = role === "A" ? "B" : "A";

  // winnerIndex resets to null the moment a rematch starts; keep the last
  // winner rendered on the back face while it flips away.
  if (complete) lastWinnerRef.current = game.choices[game.winnerIndex];
  const winnerName = complete ? game.choices[game.winnerIndex] : lastWinnerRef.current;

  // Tapping "Start a new game" on the winner card swaps the whole view to a
  // dedicated next-game screen (mirrors the create flow) instead of flipping
  // the winner card — no leftover winner header, no card-in-card.
  if (complete && rematchRevealed) {
    return (
      <NewGameScreen
        other={other}
        choices={rematchChoices}
        busy={busy}
        error={error}
        pairEntries={pairEntries}
        trackOpts={{ pairingId, role, token }}
        requestFill={(occasion) => fillMyFour({ pairingId, role, token, occasion })}
        onFill={(cs) => {
          rematchFilledRef.current = true;
          setRematchChoices(cs);
        }}
        onChoiceChange={(i, v) =>
          setRematchChoices((cs) => cs.map((x, j) => (j === i ? v : x)))
        }
        onClearAll={() => {
          rematchFilledRef.current = false;
          setRematchChoices(["", "", "", ""]);
        }}
        onSubmit={onRematch}
        onBack={() => setRematchRevealed(false)}
      />
    );
  }

  // The winner card (back face) is the visible face once the game completes.
  const showBack = complete;

  return (
    <div className="container">
      <h1 key={complete ? "won" : "play"} className="fade-swap">
        {complete ? "Dinner's decided 🏆" : "Cut a choice"}
      </h1>

      {!state.bothJoined &&
        // getState no longer carries the code (cache safety) — it lives in
        // the stored identity; state.code covers pre-migration identities.
        ((identity.code ?? state.code) ? (
          <PinnedInvite code={identity.code ?? state.code} />
        ) : (
          <div className="banner waiting">
            Waiting for your opponent to join…
          </div>
        ))}

      {!complete && state.bothJoined && (
        <div className={`banner ${myTurn ? "your-turn" : "waiting"}`}>
          {myTurn
            ? "Your move. Cut one. 😏"
            : `Waiting on player ${game.turn} to cut…`}
        </div>
      )}

      {state.bothJoined && (identity.code ?? state.code) && (
        <GameCodeLine
          code={identity.code ?? state.code}
          canCopy={identity.role === "A"}
        />
      )}

      <div className="flip-scene" ref={sceneRef}>
        <div
          className={`flip-card ${showBack ? "flipped" : ""} ${
            animateFlip ? "" : "no-anim"
          } ${settled ? "flip-settled" : ""}`}
        >
          <div
            className="flip-face flip-front"
            aria-hidden={showBack}
            inert={showBack ? "" : undefined}
          >
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
            aria-hidden={!showBack}
            inert={!showBack ? "" : undefined}
          >
            <WinnerFace
              winnerName={winnerName}
              complete={complete}
              iCanRematch={iCanRematch}
              onShare={onShareReveal}
              onPlatformClick={onPlatformClick}
              onTip={reportLinkClick}
              onStartNewGame={() => setRematchRevealed(true)}
            />
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {complete && !iCanRematch && (
        <div className="banner waiting">
          Waiting for player {state.nextStarter} to start the next game…
          {authEnabled && (
            <p className="upsell-line">
              <a href="#/premium" onClick={() => reportLinkClick("premium-interest")}>
                Or skip the wait — premium players deal the next 4 ⚡
              </a>
            </p>
          )}
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
        <Button variant="ghost" onClick={leaveGame}>
          Leave / switch player
        </Button>
      </div>
    </div>
  );
}
