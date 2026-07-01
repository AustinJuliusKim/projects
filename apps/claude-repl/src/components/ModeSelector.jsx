import React from "react";
import { Mode } from "@me/claude-repl-protocol";

const MODES = [
  { value: Mode.PLAN, label: "Plan", hint: "Research & propose, no edits" },
  { value: Mode.ACCEPT_EDITS, label: "Accept edits", hint: "Auto-apply file edits" },
  { value: Mode.AUTO, label: "Auto", hint: "Run everything unattended" },
];

export default function ModeSelector({ mode, onChange, disabled }) {
  return (
    <div className="mode-selector" role="radiogroup" aria-label="Permission mode">
      {MODES.map((m) => (
        <button
          key={m.value}
          className={mode === m.value ? "mode active" : "mode"}
          onClick={() => onChange(m.value)}
          disabled={disabled}
          title={m.hint}
          role="radio"
          aria-checked={mode === m.value}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
