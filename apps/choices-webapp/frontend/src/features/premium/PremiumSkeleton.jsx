import React from "react";

// Loading placeholder for PremiumView, mirroring the paywall layout (pitch
// lines, the two plan cards, the CTA) so content pops in with minimal shift.
// Same conventions as the other skeletons: 200ms fade-in delay so fast loads
// never flash, viewport-synced shimmer, static under prefers-reduced-motion,
// decorative bars aria-hidden with one polite status line for screen readers.
export default function PremiumSkeleton() {
  return (
    <div className="premium-skeleton" role="status">
      <span className="sr-only">Loading Premium…</span>
      <div aria-hidden="true">
        <div className="sk sk-line" />
        <div className="sk sk-line short" />
        <div className="plan-cards">
          <div className="sk sk-plan-card" />
          <div className="sk sk-plan-card" />
        </div>
        <div className="sk sk-cta" />
      </div>
    </div>
  );
}
