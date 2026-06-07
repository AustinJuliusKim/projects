import React, { useState } from "react";
import { createGame } from "./api.js";
import { saveIdentity } from "./storage.js";
import { enablePush, pushSupported } from "./push.js";

export default function CreateView() {
  const [choices, setChoices] = useState(["", "", "", ""]);
  const [created, setCreated] = useState(null); // { gameId, token, link }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pushOn, setPushOn] = useState(false);

  const setChoice = (i, v) =>
    setChoices((cs) => cs.map((c, j) => (j === i ? v : c)));

  async function onCreate(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await createGame(choices.map((c) => c.trim()));
      saveIdentity(res.game_id, "A", res.token);
      const base = `${window.location.origin}${window.location.pathname}`;
      const link = `${base}#/g/${res.game_id}?t=${res.inviteToken}`;
      setCreated({ gameId: res.game_id, token: res.token, link });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onShare() {
    const shareData = {
      title: "Let's decide!",
      text: "Help me pick — eliminate a choice:",
      url: created.link,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled; fall through to copy */
      }
    }
    await navigator.clipboard.writeText(created.link);
    alert("Link copied to clipboard!");
  }

  async function onEnablePush() {
    const ok = await enablePush(created.gameId, "A", created.token);
    setPushOn(ok);
    if (!ok) alert("Notifications not enabled. You can still play in the browser.");
  }

  if (created) {
    return (
      <div className="container">
        <h1>Game created 🎉</h1>
        <p className="muted">
          Send this link to your friend. They'll eliminate the first choice, then
          it's your turn.
        </p>
        <div className="link-box">{created.link}</div>
        <button className="btn primary" onClick={onShare}>
          📤 Share link
        </button>
        {pushSupported() && (
          <button
            className="btn"
            onClick={onEnablePush}
            disabled={pushOn}
          >
            {pushOn ? "🔔 Notifications on" : "🔔 Notify me when it's my turn"}
          </button>
        )}
        <a className="btn ghost" href={`#/g/${created.gameId}`}>
          Go to game →
        </a>
      </div>
    );
  }

  const ready = choices.every((c) => c.trim().length > 0);

  return (
    <div className="container">
      <h1>Pick 4 choices</h1>
      <p className="muted">
        Seed four options. Your friend eliminates one, then you, then them — last
        one standing wins.
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
      </form>
    </div>
  );
}
