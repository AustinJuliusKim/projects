import React, { useState } from "react";

// "✨ Fill my 4" (suggestion engine Phase 3). Renders occasion chips + the
// fill button above a set of choice inputs; the returned 4 land in the
// inputs and stay fully editable — that IS the swap-any-of-4 UX. Hidden
// entirely when the stack has no Bedrock model configured.
const AI_ENABLED = import.meta.env.VITE_AI_ENABLED === "true";
const OCCASIONS = ["Date night", "Quick bite", "Cozy night in"];

export default function FillMyFour({ request, onFill, signedIn = true }) {
  const [busy, setBusy] = useState(false);
  const [occasion, setOccasion] = useState(null);
  const [usesLeft, setUsesLeft] = useState(null);
  const [note, setNote] = useState(null);
  const [upsell, setUpsell] = useState(false);

  if (!AI_ENABLED) return null;

  async function onClick() {
    setNote(null);
    setUpsell(false);
    if (!signedIn) {
      setNote("Sign in to fill your 4 — 3 free fills a month.");
      setUpsell(true);
      return;
    }
    setBusy(true);
    try {
      const res = await request(occasion ?? "");
      onFill(res.choices);
      setUsesLeft(res.usesLeft);
    } catch (err) {
      if (err.code === "AI_LIMIT") {
        setNote(err.message);
        setUpsell(true);
      } else if (err.code === "SIGN_IN_REQUIRED") {
        setNote("Sign in to fill your 4 — 3 free fills a month.");
        setUpsell(true);
      } else {
        setNote(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fill-four">
      <div className="occasion-chips">
        {OCCASIONS.map((o) => (
          <button
            key={o}
            type="button"
            className={`chip ${occasion === o ? "active" : ""}`}
            onClick={() => setOccasion((cur) => (cur === o ? null : o))}
          >
            {o}
          </button>
        ))}
      </div>
      <button type="button" className="btn" onClick={onClick} disabled={busy}>
        {busy ? "Thinking…" : "✨ Fill my 4"}
      </button>
      {usesLeft != null && !note && (
        <p className="muted fill-note">
          {usesLeft} free {usesLeft === 1 ? "fill" : "fills"} left this month.
        </p>
      )}
      {note && (
        <p className="muted fill-note">
          {note} <a href="#/account">{upsell ? "Go premium →" : ""}</a>
        </p>
      )}
    </div>
  );
}
