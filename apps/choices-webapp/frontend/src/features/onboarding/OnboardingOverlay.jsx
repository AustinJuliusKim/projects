import React, { useEffect, useRef, useState } from "react";
import Button from "@/components/Button.jsx";
import { track } from "@/lib/api.js";
import { STEPS, CONDENSED_STEP, NavPeek } from "@/features/onboarding/steps.jsx";

// The first-run tour dialog. Two surfaces: the full step carousel (organic
// landing) and the one-tap condensed concept card (join links — that flow
// must gain near-zero friction). Every way out marks the user onboarded;
// only the analytics outcome distinguishes completing from skipping.
export default function OnboardingOverlay({ surface, onDismiss }) {
  const [step, setStep] = useState(0);
  const primaryRef = useRef(null);
  const condensed = surface === "condensed";
  const steps = condensed ? [CONDENSED_STEP] : STEPS;
  const current = steps[step];
  const last = step === steps.length - 1;
  const titleId = "onboard-title";

  useEffect(() => {
    track("onboarding_shown", { variant: surface });
    document.body.classList.add("no-scroll");
    return () => document.body.classList.remove("no-scroll");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus follows the primary button on mount and every step change.
  useEffect(() => {
    primaryRef.current?.focus();
  }, [step]);

  function dismiss(outcome) {
    onDismiss(outcome, { variant: surface, lastStep: step + 1 });
  }

  function next() {
    if (last) {
      dismiss("completed");
      // End inside the funnel, not back at a static screen. The condensed
      // card stays put — the joiner is already exactly where they need to be.
      if (!condensed) window.location.hash = "#/create";
    } else {
      setStep(step + 1);
    }
  }

  return (
    <div
      className="onboard-backdrop"
      // An accidental backdrop tap would permanently mark the full tour seen,
      // so only the one-tap condensed card treats it as "got it".
      onClick={condensed ? () => dismiss("completed") : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") dismiss("skipped");
      }}
    >
      <div
        className="onboard-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="onboard-head">
          {!condensed && (
            <Button variant="link" onClick={() => dismiss("skipped")}>
              Skip
            </Button>
          )}
        </div>
        <div key={current.id} className="fade-swap">
          <div className="onboard-art" aria-hidden="true">
            {current.art}
          </div>
          <h2 className="onboard-title" id={titleId}>
            {current.title}
          </h2>
          <p className="onboard-body">{current.body}</p>
          {current.navpeek && <NavPeek />}
        </div>
        {!condensed && (
          <div className="onboard-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.id} className={`onboard-dot${i === step ? " active" : ""}`} />
            ))}
          </div>
        )}
        <Button variant="primary" ref={primaryRef} onClick={next}>
          {condensed ? "Got it →" : last ? "Start a game →" : "Next →"}
        </Button>
      </div>
    </div>
  );
}
