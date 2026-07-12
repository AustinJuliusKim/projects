/**
 * Rail-only staged lead capture card (Accounts & Progress Spec funnel):
 * optional name/email inputs with purpose copy, an explicit consent
 * checkbox (NEVER pre-checked), Save, and Skip when the step is optional.
 * Name input is validated against the protocol's sanitizeUserName charset
 * allowlist before it ever leaves the card.
 */

import { useState } from "react";
import { marked } from "marked";
import { sanitizeUserName } from "@guided-repl/protocol";

const NAME_ERROR = "letters, numbers, spaces, . ' - only (30 max)";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {{
 *   step: {id: string, fields: Array<"name"|"email">, purposeMd: string, optional: boolean, consent?: {label: string}},
 *   onSubmit: (stepId: string, values: {name?: string, email?: string}, consent: boolean) => void,
 *   onSkip: (stepId: string) => void,
 * }} props
 */
export default function CaptureCard({ step, onSubmit, onSkip }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState(null);

  const wantsName = step.fields.includes("name");
  const wantsEmail = step.fields.includes("email");

  function submit() {
    const values = {};
    if (wantsName && name.trim() !== "") {
      const sanitized = sanitizeUserName(name);
      if (!sanitized) {
        setError(NAME_ERROR);
        return;
      }
      values.name = sanitized;
    }
    if (wantsEmail && email.trim() !== "") {
      if (!EMAIL_RE.test(email.trim())) {
        setError("enter a valid email address");
        return;
      }
      values.email = email.trim();
    }
    setError(null);
    onSubmit(step.id, values, consent);
  }

  return (
    <div className="capture-card" data-testid="capture-card">
      <div
        className="capture-purpose"
        // Authored first-party lesson copy from the compiled manifest.
        dangerouslySetInnerHTML={{ __html: marked.parse(step.purposeMd) }}
      />
      {wantsName && (
        <input
          type="text"
          className="capture-input"
          data-testid="capture-name-input"
          placeholder="Your name"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      )}
      {wantsEmail && (
        <input
          type="email"
          className="capture-input"
          data-testid="capture-email-input"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
        />
      )}
      {step.consent && (
        <label className="capture-consent">
          <input
            type="checkbox"
            data-testid="capture-consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          {step.consent.label}
        </label>
      )}
      {error && (
        <div className="capture-error" data-testid="capture-error">
          {error}
        </div>
      )}
      <div className="capture-actions">
        <button type="button" className="capture-submit" data-testid="capture-submit" onClick={submit}>
          Save
        </button>
        {step.optional && (
          <button type="button" className="capture-skip" data-testid="capture-skip" onClick={() => onSkip(step.id)}>
            Skip
          </button>
        )}
      </div>
    </div>
  );
}
