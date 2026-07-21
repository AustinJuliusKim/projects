import React from "react";
import { PLATFORMS } from "@/features/game/affiliates.js";
import TipJar from "@/features/premium/support.jsx";
import Button from "@/components/Button.jsx";
import NavButton from "@/components/NavButton.jsx";
import { authEnabled, hasSession } from "@/lib/auth.js";
import { useMe } from "@/hooks/useMe.js";

// One-line account hook for the winner screen (post-value placement, like
// the tip jar): guests get the sign-in pitch, free accounts the locked-streak
// teaser, premium the live streak. Renders nothing when accounts are off.
function WinnerAccountLine() {
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

// The winner card content (flip-card back face): "Get {winner}" + affiliate
// order buttons + share/new-game actions. The flip mechanics and all game
// state stay in PlayView; this renders purely from winnerName + callbacks.
export default function WinnerFace({
  winnerName,
  complete,
  iCanRematch,
  onShare,
  onPlatformClick,
  onTip,
  onStartNewGame,
}) {
  if (winnerName == null) return null;
  return (
    <div className="get-winner">
      <h2 className="reveal" style={{ "--d": "550ms" }}>
        Get {winnerName}
      </h2>
      <div className="platform-btns reveal" style={{ "--d": "650ms" }}>
        {PLATFORMS.map((p) => (
          <NavButton
            key={p.id}
            className="platform"
            style={{ "--brand": p.brandColor }}
            href={p.buildUrl(winnerName)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => onPlatformClick(e, p)}
          >
            {p.iconPath ? (
              <svg
                className="platform-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path d={p.iconPath} />
              </svg>
            ) : (
              <span className="platform-icon monogram" aria-hidden="true">
                {p.monogram}
              </span>
            )}
            <span className="platform-label">{p.label}</span>
          </NavButton>
        ))}
      </div>
      <p className="disclosure muted reveal" style={{ "--d": "750ms" }}>
        We may earn a commission from these links.
        <br />
        Not affiliated with or endorsed by these platforms.
      </p>
      <div className="reveal" style={{ "--d": "850ms" }}>
        <div className="reveal-actions">
          <Button onClick={onShare}>📸 Share the reveal</Button>
          {iCanRematch && (
            <Button variant="primary" onClick={onStartNewGame}>
              🔄 Start a new game
            </Button>
          )}
        </div>
        <TipJar compact onTip={onTip} />
        {complete && <WinnerAccountLine />}
      </div>
    </div>
  );
}
