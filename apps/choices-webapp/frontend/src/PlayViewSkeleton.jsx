import React from "react";

// Loading placeholder for PlayView, mirroring the loaded layout (title,
// turn banner, 4 choice cards) so the game pops in with zero layout shift.
// Same conventions as AccountSkeleton: 200ms fade-in delay so fast loads
// never flash, viewport-synced shimmer, static under prefers-reduced-motion,
// decorative bars aria-hidden with one polite status line for screen readers.
export default function PlayViewSkeleton() {
  return (
    <div className="play-skeleton" role="status">
      <span className="sr-only">Loading your game…</span>
      <div aria-hidden="true">
        <div className="sk sk-title" />
        <div className="sk sk-banner" />
        <ul className="choices">
          {[0, 1, 2, 3].map((i) => (
            <li className="choice" key={i}>
              <div className="sk sk-choice" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
