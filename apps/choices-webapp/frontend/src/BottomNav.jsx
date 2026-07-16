import React from "react";
import { authEnabled, getProfile } from "./auth.js";
import { readStreak } from "./streakCache.js";

// Which pill lights up for a given hash. Every route in the app resolves to
// one of these four: the unlisted entry hashes (#/create, #/join) plus the
// bare "#/" and "" fall through to Home; secondary screens reached from a
// tab (#/cancel from Premium, #/admin from Settings) keep that tab lit.
export function activeTab(hash) {
  if (hash.startsWith("#/history")) return "history";
  if (hash.startsWith("#/premium") || hash.startsWith("#/cancel")) return "premium";
  if (hash.startsWith("#/settings") || hash.startsWith("#/admin")) return "settings";
  return "home";
}

const TABS = [
  { id: "home", href: "#/", label: "Home" },
  { id: "history", href: "#/history", label: "History" },
  { id: "premium", href: "#/premium", label: "Premium" },
  { id: "settings", href: "#/settings", label: "Settings" },
];

// Feather-style icons, 24x24, stroke="currentColor" (set on the <svg>);
// sparkle is the one filled glyph.
const ICONS = {
  home: (
    <>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </>
  ),
  premium: (
    <path
      d="M12 3l2 5.9L20 11l-6 2.1L12 19l-2-5.9L4 11l6-2.1z"
      fill="currentColor"
      stroke="none"
    />
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
};

// The floating pill bottom nav — the app's four destinations. Premium is
// hidden entirely when accounts are off (native shell, or a web build
// without Cognito configured — one flag, authEnabled, covers both).
export default function BottomNav({ hash }) {
  const active = activeTab(hash);

  // Same zero-API-call contract as the old AccountCorner streak chip.
  const cached = readStreak(getProfile()?.sub);
  const streak =
    cached && !cached.streakLocked && cached.currentStreak >= 1
      ? cached.currentStreak
      : null;

  return (
    <nav className="bottom-nav" aria-label="Main">
      {TABS.filter((t) => t.id !== "premium" || authEnabled).map((t) => (
        <a
          key={t.id}
          className={`bottom-nav-tab${active === t.id ? " active" : ""}`}
          href={t.href}
          aria-label={t.label}
        >
          <svg
            className="bottom-nav-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {ICONS[t.id]}
          </svg>
          {t.id === "history" && streak != null && (
            <span className="bottom-nav-badge">🔥{streak}</span>
          )}
        </a>
      ))}
    </nav>
  );
}
