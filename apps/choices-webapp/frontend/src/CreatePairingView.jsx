import React, { useState } from "react";
import { createPairing, claimSeat, linkClick } from "./api.js";
import { saveIdentity } from "./storage.js";
import { enablePush, pushSupported } from "./push.js";
import { isNative, WEB_ORIGIN } from "./platform.js";
import IosInstallHint from "./IosInstallHint.jsx";
import TipJar, { PremiumTease } from "./support.jsx";

export default function CreatePairingView({ onReady }) {
  const [choices, setChoices] = useState(["", "", "", ""]);
  const [created, setCreated] = useState(null); // { pairingId, code }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [premiumInterest, setPremiumInterest] = useState(false);

  const setChoice = (i, v) =>
    setChoices((cs) => cs.map((c, j) => (j === i ? v : c)));

  async function onCreate(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await createPairing(choices.map((c) => c.trim()));
      // No identity yet — the creator claims the Host seat below.
      setCreated({ pairingId: res.pairingId, code: res.code });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onContinueAsHost() {
    setError(null);
    setBusy(true);
    try {
      const res = await claimSeat(created.code, "A");
      saveIdentity({ pairingId: res.pairingId, role: "A", token: res.token, code: res.code });
      if (pushSupported()) {
        enablePush(res.pairingId, "A", res.token).catch(() => {});
      }
      // The tease is tapped before a seat exists — report interest now that
      // we have a token (fire-and-forget, never blocks entering the game).
      if (premiumInterest) {
        linkClick(
          res.pairingId,
          "A",
          res.token,
          res.state.gameNumber,
          "premium-interest"
        ).catch(() => {});
      }
      if (onReady) onReady();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function joinLink(code) {
    // Inside the native shell the location origin is capacitor://localhost —
    // recipients need the web app.
    const base = isNative
      ? `${WEB_ORIGIN}/`
      : `${window.location.origin}${window.location.pathname}`;
    return `${base}#/join?code=${encodeURIComponent(code)}`;
  }

  async function onShare() {
    const text = `Join my game on Choices! Open the app and enter code: ${created.code}`;
    const shareData = { title: "Choices", text, url: joinLink(created.code) };
    if (isNative) {
      const { Share } = await import("@capacitor/share");
      try {
        await Share.share(shareData);
      } catch {
        /* sheet dismissed */
      }
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* cancelled -> fall through */
      }
    }
    await navigator.clipboard.writeText(`${text}\n${joinLink(created.code)}`);
    alert("Invite copied to clipboard!");
  }

  if (created) {
    return (
      <div className="container">
        <h1>Game created 🎉</h1>
        <p className="muted">
          Share this code with your friend. They open the app, tap “Join with a
          code,” enter it, and pick “I was invited.”
        </p>

        <div className="code-display">{created.code}</div>

        <button className="btn" onClick={onShare}>
          📤 Share invite
        </button>
        <button className="btn primary" onClick={onContinueAsHost} disabled={busy}>
          {busy ? "Setting up…" : "Continue as Host →"}
        </button>
        {error && <p className="error">{error}</p>}

        <TipJar />
        <PremiumTease onInterest={() => setPremiumInterest(true)} />

        <IosInstallHint />
      </div>
    );
  }

  const ready = choices.every((c) => c.trim().length > 0);

  return (
    <div className="container">
      <h1>Pick 4 choices</h1>
      <p className="muted">
        Seed four options. Your friend cuts one first, then you, then them —
        last one standing wins.
      </p>
      <form onSubmit={onCreate}>
        {choices.map((c, i) => (
          <input
            key={i}
            className="choice-input"
            placeholder={`Choice ${i + 1}`}
            value={c}
            maxLength={60}
            onChange={(e) => setChoice(i, e.target.value)}
          />
        ))}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={!ready || busy}>
          {busy ? "Creating…" : "Create game"}
        </button>
        <a className="btn ghost" href="#/">
          ← Back
        </a>
      </form>
    </div>
  );
}
