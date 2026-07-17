import React from "react";

// Loading placeholder for HistoryView, mirroring the loaded layout exactly
// (same .stats-row/.stat-card/.history containers) so content pops in with
// zero layout shift. Best-practice notes baked in:
//  - appears only after ~200ms (CSS fade-in delay) so fast loads never flash
//  - shimmer is fast (~1.2s) and viewport-synced; static under
//    prefers-reduced-motion
//  - the bars are decorative (aria-hidden); screen readers get one polite
//    "Loading" status line instead
export default function AccountSkeleton() {
  return (
    <div className="account-skeleton" role="status">
      <span className="sr-only">Loading your games…</span>
      <div aria-hidden="true">
        <div className="stats-row">
          <div className="stat-card">
            <div className="sk sk-stat-value" />
            <div className="sk sk-stat-label" />
          </div>
          <div className="stat-card">
            <div className="sk sk-stat-value" />
            <div className="sk sk-stat-label" />
          </div>
        </div>

        <div className="sk sk-premium" />

        <div className="sk sk-segmented" />

        <div className="history">
          {[0, 1, 2, 3].map((i) => (
            <div className="sk-row" key={i}>
              <div className="sk sk-row-main" style={{ width: `${62 - i * 7}%` }} />
              <div className="sk sk-row-side" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
