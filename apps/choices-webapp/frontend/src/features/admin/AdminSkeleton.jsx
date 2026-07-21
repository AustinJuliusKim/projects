import React from "react";

// Loading placeholder for the admin activity dashboard, mirroring the loaded
// Overview layout (3 stat tiles + two panels) inside the same containers so
// data lands with zero layout shift. Same conventions as AccountSkeleton:
// 200ms fade-in delay, viewport-synced shimmer, static under
// prefers-reduced-motion, decorative bars aria-hidden with one status line.
export default function AdminSkeleton() {
  return (
    <div className="admin-skeleton" role="status">
      <span className="sr-only">Loading activity…</span>
      <div aria-hidden="true">
        <div className="admin-tiles">
          {[0, 1, 2].map((i) => (
            <div className="stat-tile" key={i}>
              <div className="sk sk-admin-num" />
              <div className="sk sk-admin-label" />
            </div>
          ))}
        </div>

        <section className="admin-panel">
          <div className="sk sk-admin-heading" />
          <div className="sk sk-admin-line" />
        </section>

        <section className="admin-panel">
          <div className="sk sk-admin-heading" />
          {[0, 1, 2, 3].map((i) => (
            <div className="sk sk-admin-bar" key={i} style={{ width: `${92 - i * 14}%` }} />
          ))}
        </section>
      </div>
    </div>
  );
}
