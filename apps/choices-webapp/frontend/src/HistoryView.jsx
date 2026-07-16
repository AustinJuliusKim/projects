import React, { useEffect } from "react";
import { track } from "./api.js";
import { authEnabled, hasSession, signIn } from "./auth.js";
import { useMe } from "./useMe.js";
import AccountSkeleton from "./AccountSkeleton.jsx";
import Button from "./Button.jsx";

// One-line account hook for the winner screen (post-value placement, like
// the tip jar): guests get the sign-in pitch, free accounts the locked-streak
// teaser, premium the live streak. Renders nothing when accounts are off.
export function WinnerAccountLine() {
  const signedIn = hasSession();
  const { me } = useMe();

  if (!authEnabled) return null;
  if (!signedIn) {
    return (
      <p className="tip-line muted">
        <a href="#/history">Sign in to keep your game history →</a>
      </p>
    );
  }
  if (!me) return null;
  return (
    <p className="tip-line muted">
      {me.stats.streakLocked ? (
        <a href="#/premium">🔥 Streak — unlock with Premium</a>
      ) : (
        <>🔥 {me.stats.currentStreak}-day streak</>
      )}
    </p>
  );
}

// History tab: stats + streak + top winners + recent games. Reachable at
// #/history even mid-game (it's above the identity gate in main.jsx); web
// only in spirit (the native shell shows a coming-soon pitch since
// authEnabled is false there).
export default function HistoryView() {
  const signedIn = hasSession();
  const { me, error } = useMe();

  // paywall_viewed (bundle C): one beacon per upsell surface actually
  // rendered this visit — enum surfaces only, nothing about the account.
  useEffect(() => {
    if (!me) return;
    if (me.stats?.streakLocked) track("paywall_viewed", { surface: "streak-lock" });
    if (me.historyLocked) track("paywall_viewed", { surface: "history-lock" });
  }, [me]);

  if (!authEnabled) {
    return (
      <div className="container">
        <h1>History</h1>
        <p className="muted">
          Your history lives on the web for now — sign-in here is coming
          soon.
        </p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="container">
        <h1>History</h1>
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

  return (
    <div className="container" aria-busy={!me && !error}>
      <h1>History</h1>

      {/* Quick path back to a new game while browsing — floats above the
          bottom nav, doesn't compete with any in-content action. */}
      <a className="fab" href="#/" aria-label="New game">
        +
      </a>

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
                Older games are in your archive —{" "}
                <a href="#/premium">Premium unlocks full history</a>.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
