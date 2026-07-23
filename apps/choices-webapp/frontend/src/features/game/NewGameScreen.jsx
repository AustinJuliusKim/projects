import React from "react";
import ChoiceInput from "@/features/game/ChoiceInput.jsx";
import FillMyFour from "@/features/game/FillMyFour.jsx";
import Button from "@/components/Button.jsx";

// Dedicated next-game screen (mirrors the create flow), shown when the
// winner card's "Start a new game" is tapped. Stateless by design: the
// choices and the fill4 provenance flag live in PlayView, so a
// "Back to results" round-trip keeps whatever was typed.
// Mirror of backend game.mjs MIN_CHOICES/MAX_CHOICES.
const MIN_CHOICES = 3;
const MAX_CHOICES = 8;

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
  onAddChoice,
  onRemoveChoice,
  onClearAll,
  onSubmit,
  onBack,
}) {
  return (
    <div className="container">
      <h1>New game 🎲</h1>
      <p className="muted">Pick new choices. Player {other} cuts first.</p>
      <form onSubmit={onSubmit}>
        <FillMyFour
          context="pairing"
          trackOpts={trackOpts}
          request={requestFill}
          onFill={onFill}
        />
        {choices.map((c, i) => (
          <div className="choice-row" key={i}>
            <ChoiceInput
              placeholder={`Choice ${i + 1}`}
              value={c}
              pairEntries={pairEntries}
              trackOpts={trackOpts}
              onChange={(v) => onChoiceChange(i, v)}
            />
            {choices.length > MIN_CHOICES && (
              <button
                type="button"
                className="choice-remove"
                aria-label={`Remove choice ${i + 1}`}
                onClick={() => onRemoveChoice(i)}
              >
                –
              </button>
            )}
          </div>
        ))}
        {choices.length < MAX_CHOICES && (
          <Button variant="ghost" type="button" onClick={onAddChoice}>
            + Add a choice
          </Button>
        )}
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
