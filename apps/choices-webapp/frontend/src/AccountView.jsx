import React, { useEffect, useState } from "react";
import { getMe, createCheckoutSession, createPortalSession, track } from "./api.js";
import { authEnabled, hasSession, getProfile, signIn, signOut } from "./auth.js";
import AccountSkeleton from "./AccountSkeleton.jsx";
import Button from "./Button.jsx";
import NavButton from "./NavButton.jsx";

// Premium purchase/manage section. Web-only by construction (AccountView is
// unreachable in the native shell): Apple 3.1.1 forbids linking to external
// payment from the iOS app; entitlements bought here still work there (3.1.3).
function PremiumSection({ me }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const premiumActive = ["active", "past_due"].includes(me.premium?.status);
  const justUpgraded = window.location.hash.includes("upgraded=1");

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
    );
  }

  if (justUpgraded) {
    // Checkout finished but the webhook hasn't landed yet.
    return (
      <div className="premium-box">
        <p className="muted">Payment received — activating your Premium…</p>
      </div>
    );
  }

  return (
    <div className="premium-box">
      <p>
        ✨ <strong>Premium</strong> — your streak, full history &amp; every
        winner you've crowned.
      </p>
      <div className="premium-btns">
        <Button
          variant="primary"
          busy={busy}
          onClick={() => go(createCheckoutSession, "monthly")}
        >
          $2.99/mo
        </Button>
        <Button
          busy={busy}
          onClick={() => go(createCheckoutSession, "annual")}
        >
          $24/yr
        </Button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// One-line account hook for the winner screen (post-value placement, like
// the tip jar): guests get the sign-in pitch, free accounts the locked-streak
// teaser, premium the live streak. Renders nothing when accounts are off.
export function WinnerAccountLine() {
  const signedIn = hasSession();
  const [me, setMe] = useState(null);

  useEffect(() => {
    if (authEnabled && signedIn) getMe().then(setMe).catch(() => {});
  }, [signedIn]);

  if (!authEnabled) return null;
  if (!signedIn) {
    return (
      <p className="tip-line muted">
        <a href="#/account">Sign in to keep your game history →</a>
      </p>
    );
  }
  if (!me) return null;
  return (
    <p className="tip-line muted">
      {me.stats.streakLocked ? (
        <a href="#/account">🔥 Streak — unlock with Premium</a>
      ) : (
        <>🔥 {me.stats.currentStreak}-day streak</>
      )}
    </p>
  );
}

// Account home: sign-in pitch for guests, stats + recent games when signed
// in. Streaks and topWinners arrive from getMe only for premium accounts —
// free accounts get locked-teaser flags instead (gated at the API).
// Reachable at #/account even mid-game; web only (authEnabled is false in
// the native shell).
export default function AccountView() {
  const signedIn = hasSession();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!signedIn) return;
    getMe()
      .then(setMe)
      .catch((err) => setError(err.message));
  }, [signedIn]);

  // paywall_viewed (bundle C): one beacon per upsell surface actually
  // rendered this visit — enum surfaces only, nothing about the account.
  useEffect(() => {
    if (!me) return;
    if (["active", "past_due"].includes(me.premium?.status)) return;
    if (me.billingAvailable) track("paywall_viewed", { surface: "account" });
    if (me.stats?.streakLocked) track("paywall_viewed", { surface: "streak-lock" });
    if (me.historyLocked) track("paywall_viewed", { surface: "history-lock" });
  }, [me]);

  if (!authEnabled) {
    return (
      <div className="container">
        <h1>My games</h1>
        <p className="muted">Accounts aren't available here yet.</p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="container">
        <h1>My games</h1>
        <p className="muted">
          Sign in to keep your game history on every device — every finished
          game, what won, and your play streak.
        </p>
        <Button variant="primary" onClick={signIn}>
          Continue with Google
        </Button>
      </div>
    );
  }

  const profile = getProfile();
  return (
    <div className="container" aria-busy={!me && !error}>
      <h1>My games</h1>
      <p className="muted">{profile?.name ?? profile?.email ?? ""}</p>

      {error && <p className="error">{error}</p>}
      {!me && !error && <AccountSkeleton />}

      {me && (
        <>
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-value">{me.stats.gamesPlayed}</div>
              <div className="stat-label">games played</div>
            </div>
            {me.stats.streakLocked ? (
              <div className="stat-card locked">
                <div className="stat-value">🔥</div>
                <div className="stat-label">streak — Premium</div>
              </div>
            ) : (
              <div className="stat-card">
                <div className="stat-value">🔥 {me.stats.currentStreak}</div>
                <div className="stat-label">
                  day streak (best {me.stats.bestStreak})
                </div>
              </div>
            )}
          </div>

          {(me.billingAvailable ||
            ["active", "past_due"].includes(me.premium?.status)) && (
            <PremiumSection me={me} />
          )}

          {me.stats.topWinners && Object.keys(me.stats.topWinners).length > 0 && (
            <div className="top-winners">
              <h2>Your winners</h2>
              <ul>
                {Object.entries(me.stats.topWinners)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([label, count]) => (
                    <li key={label}>
                      <span>{label}</span>
                      <span className="muted">×{count}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="history">
            <h2>Recent games</h2>
            {me.recentGames.length === 0 && (
              <p className="muted">
                No finished games yet — your next game will show up here.
              </p>
            )}
            <ul>
              {me.recentGames.map((g) => (
                <li key={`${g.pairingId}#${g.number}`}>
                  <span>🏆 {g.winnerLabel}</span>
                  <span className="muted">
                    {new Date(g.completedAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
            {me.historyLocked && (
              <p className="muted locked-note">
                Older games are in your archive — Premium unlocks full history.
              </p>
            )}
          </div>
        </>
      )}

      <div className="footer">
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
