import React from "react";
import ChoiceInput from "@/features/game/ChoiceInput.jsx";
import FillMyFour from "@/features/game/FillMyFour.jsx";
import Button from "@/components/Button.jsx";

// Dedicated next-game screen (mirrors the create flow), shown when the
// winner card's "Start a new game" is tapped. Stateless by design: the
// choices and the fill4 provenance flag live in PlayView, so a
// "Back to results" round-trip keeps whatever was typed.
export default function NewGameScreen({
  other,
  choices,
  busy,
  error,
  pairEntries,
  trackOpts,
  requestFill,
  onFill,
  onChoiceChange,
  onClearAll,
  onSubmit,
  onBack,
}) {
  return (
    <div className="container">
      <h1>New game 🎲</h1>
      <p className="muted">Pick 4 new choices. Player {other} cuts first.</p>
      <form onSubmit={onSubmit}>
        <FillMyFour
          context="pairing"
          trackOpts={trackOpts}
          request={requestFill}
          onFill={onFill}
        />
        {choices.map((c, i) => (
          <ChoiceInput
            key={i}
            placeholder={`Choice ${i + 1}`}
            value={c}
            pairEntries={pairEntries}
            trackOpts={trackOpts}
            onChange={(v) => onChoiceChange(i, v)}
          />
        ))}
        {error && <p className="error">{error}</p>}
        {/* Clear all is always rendered (disabled when empty) — no layout shift. */}
        <div className="form-actions">
          <Button
            variant="ghost"
            type="button"
            disabled={!choices.some((c) => c.trim())}
            onClick={onClearAll}
          >
            Clear all
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={choices.some((c) => !c.trim())}
          >
            {busy ? "Starting…" : "🎲 Start new game"}
          </Button>
        </div>
      </form>
      <div className="footer">
        <Button variant="ghost" onClick={onBack}>
          ← Back to results
        </Button>
      </div>
    </div>
  );
}
