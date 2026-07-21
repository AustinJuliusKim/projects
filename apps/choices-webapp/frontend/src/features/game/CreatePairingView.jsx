import React, { useRef, useState } from "react";
import { createPairing, claimSeat, linkClick, fillMyFour } from "@/lib/api.js";
import { hasSession } from "@/lib/auth.js";
import { saveIdentity } from "@/lib/storage.js";
import { enablePush, pushSupported } from "@/lib/push.js";
import { shareInvite } from "@/features/game/invite.js";
import IosInstallHint from "@/components/IosInstallHint.jsx";
import TipJar, { PremiumTease } from "@/features/premium/support.jsx";
import ChoiceInput from "@/features/game/ChoiceInput.jsx";
import FillMyFour from "@/features/game/FillMyFour.jsx";
import Button from "@/components/Button.jsx";

export default function CreatePairingView({ onReady }) {
  const [choices, setChoices] = useState(["", "", "", ""]);
  const [created, setCreated] = useState(null); // { pairingId, code }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [premiumInterest, setPremiumInterest] = useState(false);

  const setChoice = (i, v) =>
    setChoices((cs) => cs.map((c, j) => (j === i ? v : c)));

  // Whether the 4 came from "Fill my 4" (game_created event provenance).
  const filledRef = useRef(false);

  async function onCreate(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await createPairing(
        choices.map((c) => c.trim()),
        filledRef.current ? "fill4" : undefined
      );
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

  if (created) {
    return (
      <div className="container">
        <h1>Game created 🎉</h1>
        <p className="muted">
          Give them Choices: share this code. They tap “Enter a game code,”
          pick “I was invited,” and cut first.
        </p>

        <div className="code-display">{created.code}</div>

        <Button onClick={() => shareInvite(created.code)}>
          📤 Share invite
        </Button>
        <Button variant="primary" onClick={onContinueAsHost} busy={busy}>
          {busy ? "Setting up…" : "Continue as Host →"}
        </Button>
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
        Give them Choices. They cut one first, then you, then them — the last
        one standing is dinner.
      </p>
      <form onSubmit={onCreate}>
        <FillMyFour
          signedIn={hasSession()}
          request={(occasion) => fillMyFour({ occasion })}
          onFill={(cs) => {
            filledRef.current = true;
            setChoices(cs);
          }}
        />
        {choices.map((c, i) => (
          <ChoiceInput
            key={i}
            placeholder={`Choice ${i + 1}`}
            value={c}
            onChange={(v) => setChoice(i, v)}
          />
        ))}
        {error && <p className="error">{error}</p>}
        {/* Clear all is always rendered (disabled when empty) — no layout shift. */}
        <div className="form-actions">
          <Button
            variant="ghost"
            type="button"
            disabled={!choices.some((c) => c.trim())}
            onClick={() => {
              filledRef.current = false;
              setChoices(["", "", "", ""]);
            }}
          >
            Clear all
          </Button>
          <Button variant="primary" type="submit" disabled={!ready} busy={busy}>
            {busy ? "Creating…" : "Create game"}
          </Button>
        </div>
      </form>
    </div>
  );
}
