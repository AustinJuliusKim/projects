import React, { useState } from "react";
import { isNative } from "./platform.js";

// Tip-the-dev links + premium tease (growth plan §8). Tips are goodwill /
// hosting money, not revenue — placement is post-value only (created screen,
// winner screen, landing footer), never a modal.
//
// URLs come from env vars so builds without them render nothing (same
// graceful degradation as the affiliate wrappers in affiliates.js).
// Platform ids must be in SUPPORT_PLATFORMS in backend/game.mjs.
const TIP_LINKS = [
  {
    id: "tip-venmo",
    label: "Venmo",
    url: import.meta.env.VITE_TIP_VENMO_URL || "",
  },
  {
    id: "tip-stripe",
    label: "Card",
    url: import.meta.env.VITE_TIP_STRIPE_URL || "",
  },
].filter((l) => l.url);

// compact: one muted text line (winner screen, landing footer).
// default: small card for the "Game created" screen.
// onTip(platformId): optional fire-and-forget beacon — only callers with a
// claimed seat can report (the landing page has no pairing context).
//
// Hidden in the native shell: Apple guideline 3.1.1 requires developer tips
// inside an iOS app to use In-App Purchase — external payment links there
// risk App Store rejection. Web only.
export default function TipJar({ compact = false, lead, onTip }) {
  if (isNative || TIP_LINKS.length === 0) return null;

  const links = TIP_LINKS.map((l, i) => (
    <React.Fragment key={l.id}>
      {i > 0 && " · "}
      <a
        href={l.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => onTip && onTip(l.id)}
      >
        {l.label}
      </a>
    </React.Fragment>
  ));

  if (compact) {
    return (
      <p className="tip-line muted">
        {lead ?? "☕ Enjoyed it? Tip the dev:"} {links}
      </p>
    );
  }

  return (
    <div className="tip-jar">
      <p className="muted">
        Choices is free, ad-free, and built by one person — a tip helps cover
        the servers. ☕
      </p>
      <p className="tip-line">{links}</p>
    </div>
  );
}

// "Premium coming soon" interest gauge on the created screen. Nothing to
// sell yet — a tap just flips to a thank-you and reports interest via the
// linkClick pipeline (deferred until the host claims a seat, see
// CreatePairingView).
export function PremiumTease({ onInterest }) {
  const [noted, setNoted] = useState(false);

  if (noted) {
    return <p className="premium-tease muted">Thanks — noted! 🙌</p>;
  }
  return (
    <p className="premium-tease muted">
      <button
        className="link-btn"
        onClick={() => {
          setNoted(true);
          if (onInterest) onInterest();
        }}
      >
        ✨ Premium — bigger games &amp; themes, coming soon
      </button>
    </p>
  );
}
