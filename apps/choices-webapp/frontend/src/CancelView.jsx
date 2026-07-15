import React, { useEffect, useState } from "react";
import { getMe, cancelSubscription } from "./api.js";
import { authEnabled, hasSession } from "./auth.js";

// The cute unsubscribe page (reached from the Premium badge). Choicey makes a
// cheeky plea, then a single Confirm sets cancel_at_period_end at Stripe — the
// member keeps Premium until the paid period ends. Web-only, like the rest of
// the billing surface.
export default function CancelView() {
  const signedIn = hasSession();
  const [me, setMe] = useState(null);
  const [phase, setPhase] = useState("confirm"); // confirm | busy | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (authEnabled && signedIn) getMe().then(setMe).catch(() => {});
  }, [signedIn]);

  const premiumActive =
    me && ["active", "past_due"].includes(me.premium?.status);
  const alreadyCanceling = me?.premium?.cancelAtPeriodEnd;
  // Only "loading" while we're genuinely fetching (signed in). A guest never
  // fetches, so it falls straight through to the not-premium state.
  const loading = authEnabled && signedIn && !me;

  async function confirmCancel() {
    setPhase("busy");
    setError(null);
    try {
      const res = await cancelSubscription();
      setResult(res);
      setPhase("done");
    } catch (err) {
      setError(err.message);
      setPhase("confirm");
    }
  }

  const fmt = (ms) => (ms ? new Date(ms).toLocaleDateString() : null);

  return (
    <div className="container cancel-view">
      <img
        className="choicey"
        src="/choicey.png"
        alt="Choicey the raccoon, looking hopeful"
        width="220"
        height="220"
      />

      {phase === "done" ? (
        <>
          <h1>Okay… I'll put the knife down. 🥺</h1>
          <p>
            {result?.currentPeriodEnd
              ? `You'll keep Premium until ${fmt(result.currentPeriodEnd)} — nothing changes before then.`
              : "Your Premium is set to cancel at the end of your billing period."}
          </p>
          <p className="muted">Change your mind? You can resubscribe anytime.</p>
          <a className="btn primary" href="#/account">
            Back to my games
          </a>
        </>
      ) : loading ? (
        <p className="muted" aria-busy="true">Loading…</p>
      ) : !premiumActive ? (
        <>
          <h1>Nothing to cancel</h1>
          <p className="muted">You're not on Premium right now.</p>
          <a className="btn primary" href="#/account">
            Back to my games
          </a>
        </>
      ) : alreadyCanceling ? (
        <>
          <h1>You're all set 🦝</h1>
          <p>
            {me.premium?.currentPeriodEnd
              ? `Your Premium is already ending on ${fmt(me.premium.currentPeriodEnd)}.`
              : "Your Premium is already set to cancel at period end."}
          </p>
          <a className="btn primary" href="#/account">
            Back to my games
          </a>
        </>
      ) : (
        <>
          <h1>Leaving so soon?</h1>
          <p className="cancel-quote">
            “Aw, c'mon — I was just getting warmed up. Keep me around and I'll
            keep your streak safe. Promise.”
            <span className="cancel-sign">— Choicey</span>
          </p>
          <p className="muted">
            You'll keep Premium until the end of your billing period, so there's
            no immediate loss.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="cancel-actions">
            <a className="btn primary" href="#/account">
              Never mind, keep Premium
            </a>
            <button
              className="btn danger"
              disabled={phase === "busy"}
              onClick={confirmCancel}
            >
              {phase === "busy" ? "Canceling…" : "Confirm cancel"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
