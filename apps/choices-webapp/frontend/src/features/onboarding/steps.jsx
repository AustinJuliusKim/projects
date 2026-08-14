import React from "react";
import { authEnabled } from "@/lib/auth.js";
import { ICONS } from "@/components/BottomNav.jsx";

// Static lookalike of the bottom nav for the "your app" step — the backdrop
// covers the real bar, so the tour shows this instead. Reuses the exported
// ICONS and the same authEnabled filter, so it can never promise a tab that
// doesn't exist (Premium is hidden on native / no-Cognito builds).
export function NavPeek() {
  const tabs = ["home", "history", "premium", "settings"].filter(
    (id) => id !== "premium" || authEnabled
  );
  return (
    <div className="onboard-navpeek" aria-hidden="true">
      {tabs.map((id) => (
        <span key={id} className="onboard-navpeek-tab">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {ICONS[id]}
          </svg>
        </span>
      ))}
    </div>
  );
}

// Copy per Growth Plan §9: the verb is "cut", the tease targets the
// indecision (never the partner), ≤1 emoji per line.
export const STEPS = [
  {
    id: "concept",
    art: "🍜🌮🍕🍣",
    title: "You've got Choices",
    body: "4 choices. Cut them down. 1 winner. No blame, no apathy.",
  },
  {
    id: "create",
    art: "✍️",
    title: "Give them Choices",
    body:
      "Type 3–8 things you'd actually eat. You get a code like PLUM-42 — send it to whoever's being indecisive.",
  },
  {
    id: "cut",
    art: "✂️",
    title: "Take turns cutting",
    body:
      "They cut first, then you, back and forth. Every cut is one less thing to argue about. \u{1F60F}",
  },
  {
    id: "winner",
    art: "🏆",
    title: "Last dish standing wins",
    body: "Whatever survives is dinner. Nobody picked it, so nobody's to blame.",
    navpeek: true,
  },
];

export const CONDENSED_STEP = {
  id: "condensed",
  art: "✂️",
  title: "How this works",
  body:
    "Someone gave you Choices. Cut one at a time — last dish standing wins. \u{1F60F}",
};
