import React, { useEffect, useState } from "react";
import { createCheckoutSession, createPortalSession, track } from "./api.js";
import { hasSession, signIn } from "./auth.js";
import { useMe } from "./useMe.js";
import Button from "./Button.jsx";
import NavButton from "./NavButton.jsx";
import TipJar from "./support.jsx";

const PLANS = {
  monthly: { label: "Monthly", price: "$2.99/mo" },
  annual: { label: "Yearly", price: "$24/yr", note: "2 months free" },
};

// Premium tab. Web-only by construction — the route (main.jsx) falls through
// to Home when !authEnabled, so this never renders in the native shell:
// Apple 3.1.1 forbids linking to external payment from the iOS app;
// entitlements bought here still work there (3.1.3).
export default function PremiumView() {
  const signedIn = hasSession();
  const { me, refresh } = useMe();
  const [plan, setPlan] = useState("annual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const justUpgraded = window.location.hash.includes("upgraded=1");

  // Checkout finished but the webhook may not have landed yet — force one
  // fresh getMe so the premium badge appears the moment it has.
  useEffect(() => {
    if (justUpgraded && signedIn) refresh({ force: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justUpgraded, signedIn]);

  const premiumActive =
    signedIn && ["active", "past_due"].includes(me?.premium?.status);

  // paywall_viewed (bundle C): fires once the not-premium paywall actually
  // renders for a signed-in account with billing available. Reuses the
  // existing "account" enum surface — this tab is that surface's successor.
  useEffect(() => {
    if (signedIn && me && !premiumActive && me.billingAvailable) {
      track("paywall_viewed", { surface: "account" });
    }
  }, [signedIn, me, premiumActive]);

  async function go(fn, arg) {
    setBusy(true);
    setError(null);
    try {
      const { url } = await fn(arg);
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (premiumActive) {
    const p = me.premium ?? {};
    const renews = p.currentPeriodEnd
      ? new Date(p.currentPeriodEnd).toLocaleDateString()
      : null;
    const status = p.cancelAtPeriodEnd
      ? renews
        ? `Premium until ${renews}`
        : "Premium — canceling at period end"
      : renews
      ? `Renews ${renews}`
      : "Thanks for the support!";
    return (
      <div className="container">
        <h1>Premium</h1>
        <div className="premium-badge">
          <span className="premium-badge-crest" aria-hidden="true">
            ✨
          </span>
          <div className="premium-badge-body">
            <div className="premium-badge-title">Premium</div>
            <div className="premium-badge-sub">{status}</div>
          </div>
          <div className="premium-badge-actions">
            <Button
              variant="ghost"
              busy={busy}
              onClick={() => go(createPortalSession)}
            >
              Manage billing
            </Button>
            {!p.cancelAtPeriodEnd && (
              <NavButton variant="ghost" href="#/cancel">
                Cancel subscription
              </NavButton>
            )}
          </div>
          {error && <p className="error">{error}</p>}
        </div>
        <TipJar />
      </div>
    );
  }

  if (justUpgraded) {
    return (
      <div className="container">
        <h1>Premium</h1>
        <div className="premium-box">
          <p className="muted">Payment received — activating your Premium…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Premium</h1>
      <p>
        ✨ <strong>Go Premium</strong> — your full streak, complete history,
        near-me suggestions, and dealing the next 4 without waiting your turn.
      </p>

      <div className="plan-cards">
        {Object.entries(PLANS).map(([id, p]) => (
          <button
            key={id}
            type="button"
            className={`plan-card${plan === id ? " selected" : ""}`}
            aria-pressed={plan === id}
            onClick={() => setPlan(id)}
          >
            <span>{p.label}</span>
            <span className="plan-price">{p.price}</span>
            {p.note && <span className="plan-note">{p.note}</span>}
          </button>
        ))}
      </div>

      {signedIn ? (
        <Button
          variant="primary"
          busy={busy}
          onClick={() => go(createCheckoutSession, plan)}
        >
          Continue — {PLANS[plan].price}
        </Button>
      ) : (
        <Button variant="primary" onClick={signIn}>
          Sign in to go Premium
        </Button>
      )}
      {error && <p className="error">{error}</p>}

      <TipJar />
    </div>
  );
}
