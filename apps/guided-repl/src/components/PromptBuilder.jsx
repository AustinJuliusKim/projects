/**
 * Three locked segmented choice groups (task/subject/constraint) plus a
 * live assembled-prompt preview and a Run button.
 */

import { useMemo, useState } from "react";
import { buildPrompt } from "../lessons/promptBuilder.js";

/**
 * @param {{label: string, options: string[], value: string, onChange: (v: string) => void}} props
 */
function ChoiceGroup({ label, options, value, onChange }) {
  return (
    <fieldset className="choice-group">
      <legend>{label}</legend>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`choice-option ${value === option ? "choice-option-selected" : ""}`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * @param {{promptChoices: {task: string[], subject: string[], constraint: string[]}, status: string, hint: object|null, onSubmit: (text: string) => void}} props
 */
export default function PromptBuilder({ promptChoices, status, hint, onSubmit }) {
  const [task, setTask] = useState(promptChoices.task[0]);
  const [subject, setSubject] = useState(promptChoices.subject[0]);
  const [constraint, setConstraint] = useState(promptChoices.constraint[0]);

  const assembled = useMemo(() => buildPrompt({ task, subject, constraint }), [task, subject, constraint]);

  const running = status === "running";

  return (
    <div className="prompt-builder" data-testid="prompt-builder">
      <ChoiceGroup label="Task" options={promptChoices.task} value={task} onChange={setTask} />
      <ChoiceGroup label="Subject" options={promptChoices.subject} value={subject} onChange={setSubject} />
      <ChoiceGroup label="Constraint" options={promptChoices.constraint} value={constraint} onChange={setConstraint} />

      <div className="cli-input-box">
        <div className="prompt-preview" data-testid="prompt-preview">
          <span className="cli-prompt-marker">&gt;</span> {assembled}
        </div>

        {hint && (
          <div className="hint-bubble" data-testid="hint">
            {hint.text ? `That combination isn't part of this lesson — try one of the guided choices.` : hint.message}
          </div>
        )}

        <button
          type="button"
          className="run-button"
          data-testid="run-button"
          disabled={running}
          onClick={() => onSubmit(assembled)}
        >
          Run
        </button>
      </div>
    </div>
  );
}
