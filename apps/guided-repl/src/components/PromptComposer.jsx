/**
 * Terminal-pane prompt input with autocompletion, styled after Claude
 * Code's slash-command menu. Guided mode: suggestions are the lesson's
 * branch prompts and only a completed match can run — the visible menu
 * makes the constraint self-disclosing. Drill mode (freeText): plain typed
 * input, matched by the caller (no suggestions menu).
 *
 * Keys: ↑↓ navigate · Tab complete · Enter run · Esc dismiss.
 */

import { useMemo, useRef, useState } from "react";
import { interpolateUserName } from "@guided-repl/protocol";
import { filterSuggestions } from "../lessons/fuzzyMatch.js";

/** Same normalization as matchPrompt — the binding contract. */
function normalize(text) {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * @param {{
 *   suggestions: Array<{text: string, description?: string, branchId?: string}>,
 *   status: string,
 *   hint: object|null,
 *   onSubmit: (text: string, branchId?: string) => void,
 *   freeText?: boolean,
 *   placeholder?: string,
 *   userName?: string|null,
 *   compact?: boolean,
 * }} props
 */
export default function PromptComposer({ suggestions, status, hint, onSubmit, freeText = false, placeholder, userName = null, compact = false }) {
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Set when the user picks a menu option — disambiguates suggestions whose
  // prompt text is identical across branches (l4/l5/l7/l8). Cleared on edit.
  const [picked, setPicked] = useState(null);
  const [localHint, setLocalHint] = useState(null);
  const inputRef = useRef(null);

  const running = status === "running";

  // Display text is {{userName}}-interpolated; rawText keeps the authored
  // token so submits preserve the matchPrompt/expectedPrompt contract
  // (branchId precedence already handles the personalized display text).
  const displaySuggestions = useMemo(
    () => suggestions.map((s) => ({ ...s, text: interpolateUserName(s.text, userName), rawText: s.text })),
    [suggestions, userName],
  );

  const filtered = useMemo(
    () => (freeText ? [] : filterSuggestions(input, displaySuggestions)),
    [freeText, input, displaySuggestions],
  );

  const exactMatches = useMemo(
    () => (freeText ? [] : displaySuggestions.filter((s) => normalize(s.text) === normalize(input))),
    [freeText, input, displaySuggestions],
  );
  const resolved =
    picked && normalize(picked.text) === normalize(input)
      ? picked
      : exactMatches.length === 1
        ? exactMatches[0]
        : null;
  const canRun = freeText ? normalize(input).length > 0 : Boolean(resolved);

  function submit() {
    if (running) return;
    if (freeText) {
      if (!canRun) return;
      onSubmit(input);
      setInput("");
      return;
    }
    if (!resolved) {
      setLocalHint(
        exactMatches.length > 1
          ? "That prompt has more than one variant — pick one from the menu."
          : "Pick one of the suggested prompts — this lesson replays a recorded run.",
      );
      setMenuOpen(true);
      return;
    }
    onSubmit(resolved.rawText ?? resolved.text, resolved.branchId);
    setMenuOpen(false);
    setLocalHint(null);
  }

  /** @param {{text: string, branchId?: string}} suggestion */
  function pick(suggestion) {
    setInput(suggestion.text);
    setPicked(suggestion);
    setMenuOpen(false);
    setLocalHint(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e) {
    if (freeText) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMenuOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Tab") {
      if (menuOpen && filtered[highlight]) {
        e.preventDefault();
        pick(filtered[highlight]);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (menuOpen && filtered[highlight] && !resolved) {
        pick(filtered[highlight]);
      } else {
        submit();
      }
    } else if (e.key === "Escape") {
      setMenuOpen(false);
    }
  }

  const shownHint = localHint ?? (hint ? "That prompt isn't part of this lesson — try one of the suggestions." : null);
  const listboxId = "composer-listbox";

  return (
    <div className={`prompt-composer ${compact ? "prompt-composer-compact" : ""}`} data-testid="prompt-composer">
      <div className="cli-input-box">
        <div className="composer-row">
          <span className="cli-prompt-marker">&gt;</span>
          <input
            ref={inputRef}
            type="text"
            className="composer-input"
            data-testid="composer-input"
            role="combobox"
            aria-expanded={menuOpen && filtered.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={menuOpen && filtered[highlight] ? `composer-option-${highlight}` : undefined}
            aria-autocomplete="list"
            placeholder={placeholder ?? (freeText ? "type a command…" : "Try typing: make a page…")}
            value={input}
            disabled={running}
            onChange={(e) => {
              setInput(e.target.value);
              setPicked(null);
              setMenuOpen(true);
              setHighlight(0);
              setLocalHint(null);
            }}
            onFocus={() => !freeText && setMenuOpen(true)}
            onKeyDown={onKeyDown}
          />
          {compact && (
            <button
              type="button"
              className="send-button"
              data-testid="run-button"
              aria-label="Run"
              disabled={running || !canRun}
              onClick={submit}
            >
              ↑
            </button>
          )}
        </div>

        {!freeText && menuOpen && filtered.length > 0 && (
          <ul className="composer-menu" data-testid="composer-menu" role="listbox" id={listboxId}>
            {filtered.map((suggestion, i) => (
              <li
                key={`${suggestion.branchId ?? ""}:${suggestion.text}`}
                id={`composer-option-${i}`}
                className={`composer-option ${i === highlight ? "composer-option-active" : ""}`}
                data-testid="composer-option"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(suggestion);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="composer-option-text">{suggestion.text}</span>
                {suggestion.description && <span className="composer-option-desc">{suggestion.description}</span>}
              </li>
            ))}
          </ul>
        )}

        {shownHint && (
          <div className="hint-bubble" data-testid="hint">
            {shownHint}
          </div>
        )}

        {!compact && (
          <button
            type="button"
            className="run-button"
            data-testid="run-button"
            disabled={running || !canRun}
            onClick={submit}
          >
            Run
          </button>
        )}
      </div>
    </div>
  );
}
