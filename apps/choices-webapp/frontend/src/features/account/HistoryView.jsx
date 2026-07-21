import React, { useEffect, useState } from "react";
import { track } from "@/lib/api.js";
import { authEnabled, hasSession, signIn } from "@/lib/auth.js";
import { useMe } from "@/hooks/useMe.js";
import AccountSkeleton from "@/features/account/AccountSkeleton.jsx";
import Button from "@/components/Button.jsx";

// Recent games arrive fully in one getMe call (hard-capped ≤10 free / ≤50
// premium), so pagination is pure client-side slicing — no cursor/fetch.
const RECENT_PAGE_SIZE = 10;

// History tab: stats + streak + top winners + recent games. Reachable at
// #/history even mid-game (it's above the identity gate in main.jsx); web
// only in spirit (the native shell shows a coming-soon pitch since
// authEnabled is false there).
export default function HistoryView() {
  const signedIn = hasSession();
  const { me, error } = useMe();
  const [tab, setTab] = useState("winners");
  const [recentPage, setRecentPage] = useState(0);

  // paywall_viewed (bundle C): one beacon per upsell surface actually
  // rendered this visit — enum surfaces only, nothing about the account.
  useEffect(() => {
    if (!me) return;
    if (me.stats?.streakLocked) track("paywall_viewed", { surface: "streak-lock" });
    if (me.historyLocked) track("paywall_viewed", { surface: "history-lock" });
  }, [me]);

  // Client-side pagination for Recent games (10/page). safePage clamps in case
  // a background useMe refresh shrinks the list under the current page.
  const recentGames = me?.recentGames ?? [];
  const recentPageCount = Math.max(1, Math.ceil(recentGames.length / RECENT_PAGE_SIZE));
  const recentSafePage = Math.min(recentPage, recentPageCount - 1);
  const recentPageItems = recentGames.slice(
    recentSafePage * RECENT_PAGE_SIZE,
    recentSafePage * RECENT_PAGE_SIZE + RECENT_PAGE_SIZE
  );

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

          {/* Segmented pill switches between the two lists — one at a time,
              app-native rather than a long stacked scroll. */}
          <div className="segmented" role="tablist" aria-label="History lists">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "winners"}
              className={`seg-tab${tab === "winners" ? " active" : ""}`}
              onClick={() => setTab("winners")}
            >
              Winners
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "recent"}
              className={`seg-tab${tab === "recent" ? " active" : ""}`}
              onClick={() => setTab("recent")}
            >
              Recent
            </button>
          </div>

          {tab === "winners" ? (
            <div className="top-winners">
              {me.stats.topWinners && Object.keys(me.stats.topWinners).length > 0 ? (
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
              ) : (
                <p className="muted">
                  No winners yet — finish a game and your top picks show up here.
                </p>
              )}
            </div>
          ) : (
            <div className="history">
              {me.recentGames.length === 0 && (
                <p className="muted">
                  No finished games yet — your next game will show up here.
                </p>
              )}
              <ul>
                {recentPageItems.map((g) => (
                  <li key={`${g.pairingId}#${g.number}`}>
                    <span>🏆 {g.winnerLabel}</span>
                    <span className="muted">
                      {new Date(g.completedAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
              {recentPageCount > 1 && (
                <div className="pager">
                  <button
                    type="button"
                    className="pager-btn"
                    aria-label="Previous page"
                    disabled={recentSafePage === 0}
                    onClick={() => setRecentPage((p) => Math.max(0, p - 1))}
                  >
                    ‹
                  </button>
                  <span className="pager-status">
                    Page {recentSafePage + 1} / {recentPageCount}
                  </span>
                  <button
                    type="button"
                    className="pager-btn"
                    aria-label="Next page"
                    disabled={recentSafePage === recentPageCount - 1}
                    onClick={() =>
                      setRecentPage((p) => Math.min(recentPageCount - 1, p + 1))
                    }
                  >
                    ›
                  </button>
                </div>
              )}
              {me.historyLocked && (
                <p className="muted locked-note">
                  Older games are in your archive —{" "}
                  <a href="#/premium">Premium unlocks full history</a>.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
