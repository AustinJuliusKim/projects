/**
 * Mobile lesson sheet: the non-diegetic lesson-spine surfaces (instruction
 * copy, Continue, quiz, capture, grade, graduation) that live in the left
 * Rail on desktop. Renders the exact same components the Rail uses, driven
 * by the same `rail` model + callbacks — the separation contract (Lesson
 * Engine Spec §3) is preserved: this is presentation only.
 */

import { marked } from "marked";
import QuizCard from "../QuizCard.jsx";
import CaptureCard from "../CaptureCard.jsx";
import GradeBanner from "../GradeBanner.jsx";
import GraduationPanel from "../GraduationPanel.jsx";

/**
 * @param {{
 *   rail: ReturnType<import("../../engine/lessonEngine.js").railModel>,
 *   completionNext: string|null,
 *   onContinue: () => void,
 *   onQuizAnswer: (stepId: string, answerIdx: number) => void,
 *   onRetry: () => void,
 *   onCapture: (stepId: string, values: object, consent: boolean) => void,
 *   onCaptureSkip: (stepId: string) => void,
 *   onNextLesson: (lessonId: string) => void,
 *   userName?: string|null,
 *   capturedEmail?: string|null,
 * }} props
 */
export default function LessonSheet({
  rail,
  completionNext,
  onContinue,
  onQuizAnswer,
  onRetry,
  onCapture,
  onCaptureSkip,
  onNextLesson,
  userName = null,
  capturedEmail = null,
}) {
  const { mode, instructionMd, currentStep, results, graduated, latestAssertionResult } = rail;
  const assertionResult = latestAssertionResult;
  const showContinue =
    (mode === "instructing" && currentStep?.type === "instruction") ||
    (currentStep?.type === "assertion" && results[currentStep.id]?.pass && !graduated);

  return (
    <div className="m-lesson" data-testid="m-lesson">
      {instructionMd && (
        <div
          className="rail-instruction"
          data-testid="rail-instruction"
          // Authored first-party lesson copy from the compiled manifest.
          dangerouslySetInnerHTML={{ __html: marked.parse(instructionMd) }}
        />
      )}

      {showContinue && (
        <button type="button" className="rail-continue" data-testid="rail-continue" onClick={onContinue}>
          Continue
        </button>
      )}

      {currentStep?.type === "quiz" && !results[currentStep.id]?.pass && (
        <QuizCard key={currentStep.id} step={currentStep} onAnswer={onQuizAnswer} />
      )}

      {currentStep?.type === "capture" && !results[currentStep.id] && (
        <CaptureCard key={currentStep.id} step={currentStep} onSubmit={onCapture} onSkip={onCaptureSkip} />
      )}

      {assertionResult && (
        <>
          <GradeBanner result={assertionResult} />
          {!assertionResult.pass && currentStep?.type === "assertion" && (
            <button type="button" className="rail-retry" data-testid="rail-retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </>
      )}

      {graduated && completionNext === null && (
        <GraduationPanel userName={userName} capturedEmail={capturedEmail} />
      )}

      {graduated && completionNext && (
        <button
          type="button"
          className="rail-continue"
          data-testid="rail-next-lesson"
          onClick={() => onNextLesson(completionNext)}
        >
          Next lesson →
        </button>
      )}
    </div>
  );
}
