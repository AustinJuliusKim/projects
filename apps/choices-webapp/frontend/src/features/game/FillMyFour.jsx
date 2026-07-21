import React, { useEffect, useRef, useState } from "react";
import { track } from "@/lib/api.js";
import { getProfile } from "@/lib/auth.js";
import { readStreak } from "@/lib/streakCache.js";
import Button from "@/components/Button.jsx";

// "✨ Fill my 4" (suggestion engine Phase 3). Renders occasion chips + the
// fill button above a set of choice inputs; the returned 4 land in the
// inputs and stay fully editable — that IS the swap-any-of-4 UX. Hidden
// entirely when the stack has no Bedrock model configured.
//
// AI fills are a Premium feature (0 free uses — the LLM call has real cost).
// The affordance still renders for everyone as a premium teaser: a locked
// visual + upsell. The server stays authoritative (an actual premium account
// with a cold streak cache still fills on click; a free click returns
// AI_LIMIT and we show the upsell).
const AI_ENABLED = import.meta.env.VITE_AI_ENABLED === "true";
const OCCASIONS = ["Date night", "Quick bite", "Cozy night in"];

// context: "create" (create screen, default) | "pairing" (rematch form);
// trackOpts carries { pairingId, role, token } when a pairing exists.
export default function FillMyFour({ request, onFill, signedIn = true, context = "create", trackOpts = null }) {
  const [busy, setBusy] = useState(false);
  const [occasion, setOccasion] = useState(null);
  const [usesLeft, setUsesLeft] = useState(null);
  const [note, setNote] = useState(null);
  const [upsell, setUpsell] = useState(false);
  const fillCountRef = useRef(0);
  // Best-effort premium hint from the streak cache (no API call). Only used
  // to style the affordance as locked/unlocked — the server decides for real.
  const premium = !!readStreak(getProfile()?.sub)?.premium;

  // fill4_shown: once per render of the affordance (mount), enum context only.
  useEffect(() => {
    if (AI_ENABLED) track("fill4_shown", { context }, trackOpts ?? {});
  }, []); // mount-once by design; context/trackOpts are stable for a mounted form

  if (!AI_ENABLED) return null;

  async function onClick() {
    setNote(null);
    setUpsell(false);
    if (!signedIn) {
      setNote("Fill my 4 with AI is a Premium feature — sign in to unlock.");
      setUpsell(true);
      return;
    }
    setBusy(true);
    try {
      const res = await request(occasion ?? "");
      onFill(res.choices);
      setUsesLeft(res.usesLeft);
      // A re-fill replaces the previous 4 — that's the swap gesture.
      fillCountRef.current += 1;
      if (fillCountRef.current > 1) {
        track("fill4_swapped", { swap_count: fillCountRef.current - 1 }, trackOpts ?? {});
      }
    } catch (err) {
      if (err.code === "AI_LIMIT") {
        setNote(err.message);
        setUpsell(true);
      } else if (err.code === "SIGN_IN_REQUIRED") {
        setNote("Fill my 4 with AI is a Premium feature — sign in to unlock.");
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
      <Button
        type="button"
        className={`fill-btn${premium ? "" : " locked"}`}
        onClick={onClick}
        busy={busy}
      >
        {busy ? "Thinking…" : "✨ Fill my 4"}
        {!premium && <span className="fill-lock" aria-hidden="true">🔒</span>}
      </Button>
      {!premium && !note && (
        <p className="muted fill-note">Premium feature — unlimited AI fills.</p>
      )}
      {premium && usesLeft != null && !note && (
        <p className="muted fill-note">
          {usesLeft} free {usesLeft === 1 ? "fill" : "fills"} left this month.
        </p>
      )}
      {note && (
        <p className="muted fill-note">
          {note} <a href="#/premium">{upsell ? "Go premium →" : ""}</a>
        </p>
      )}
    </div>
  );
}
