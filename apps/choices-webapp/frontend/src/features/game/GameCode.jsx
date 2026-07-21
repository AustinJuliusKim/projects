import React, { useState } from "react";
import Button from "@/components/Button.jsx";
import { shareInvite } from "@/features/game/invite.js";

// Tap-to-copy feedback, local to whichever code block is on screen — the
// pinned invite (pre-join) and the mid-game line never render together.
function useCopyCode() {
  const [copied, setCopied] = useState(false);
  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selection fallback: the text stays selectable */
    }
  };
  return [copied, copy];
}

// Pinned invite on the game page while the opponent hasn't joined:
// tappable code (copy) + share button under the waiting banner.
export function PinnedInvite({ code }) {
  const [copied, copy] = useCopyCode();
  return (
    <div className="pinned-invite">
      <div className="banner waiting">
        Share this code with your opponent to begin.
      </div>
      <button
        type="button"
        className="code-display pinned"
        aria-label="Copy game code"
        onClick={() => copy(code)}
      >
        {code}
        <span className="copy-hint">{copied ? "Copied!" : "Tap to copy"}</span>
      </button>
      <Button onClick={() => shareInvite(code)}>📤 Share invite</Button>
    </div>
  );
}

// Mid-game code reminder once the game fills, so nobody loses the code:
// the host keeps a tap-to-copy affordance, the guest gets plain text.
export function GameCodeLine({ code, canCopy }) {
  const [copied, copy] = useCopyCode();
  if (!canCopy) {
    return (
      <p className="game-code-line">
        Game code: <strong>{code}</strong>
      </p>
    );
  }
  return (
    <button
      type="button"
      className="game-code-line"
      aria-label="Copy game code"
      onClick={() => copy(code)}
    >
      Game code: <strong>{code}</strong>
      <span className="copy-hint muted">
        {copied ? "Copied!" : "Tap to copy"}
      </span>
    </button>
  );
}
