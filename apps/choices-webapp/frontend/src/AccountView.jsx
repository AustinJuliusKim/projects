import React, { useEffect, useState } from "react";
import { getMe } from "./api.js";
import { authEnabled, hasSession, getProfile, signIn, signOut } from "./auth.js";

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

  if (!authEnabled) {
    return (
      <div className="container">
        <h1>My games</h1>
        <p className="muted">Accounts aren't available here yet.</p>
        <a className="btn ghost" href="#/">← Back</a>
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
        <button className="btn primary" onClick={signIn}>
          Continue with Google
        </button>
        <a className="btn ghost" href="#/">← Back</a>
      </div>
    );
  }

  const profile = getProfile();
  return (
    <div className="container">
      <h1>My games</h1>
      <p className="muted">{profile?.name ?? profile?.email ?? ""}</p>

      {error && <p className="error">{error}</p>}
      {!me && !error && <p className="muted">Loading…</p>}

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
                Older games are in your archive — Premium unlocks full history.
              </p>
            )}
          </div>
        </>
      )}

      <div className="footer">
        <a className="link-btn" href="#/">← Back</a>
        <button className="link-btn" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
