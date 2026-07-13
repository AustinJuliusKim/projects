/**
 * The left Rail: the lesson spine (Lesson Engine Spec §3). Lesson nav,
 * progress dots, current instruction copy, and the non-diegetic quiz/grade
 * surface. The Rail is the lesson engine's only full subscriber — stage
 * components never see lesson state. Collapses to a thin progress strip
 * while a run plays (mode === "running").
 */

import { marked } from "marked";
import LessonRail from "./LessonRail.jsx";
import QuizCard from "./QuizCard.jsx";
import GradeBanner from "./GradeBanner.jsx";
import CaptureCard from "./CaptureCard.jsx";
import GraduationPanel from "./GraduationPanel.jsx";

/**
 * @param {{
 *   lessons: Array<object>,
 *   activeLessonId: string,
 *   onSelectLesson: (lessonId: string) => void,
 *   rail: ReturnType<import("../engine/lessonEngine.js").railModel>,
 *   completionNext: string|null,
 *   onContinue: () => void,
 *   onQuizAnswer: (stepId: string, answerIdx: number) => void,
 *   onRetry: () => void,
 *   onCapture: (stepId: string, values: {name?: string, email?: string}, consent: boolean) => void,
 *   onCaptureSkip: (stepId: string) => void,
 *   userName?: string|null,
 *   capturedEmail?: string|null,
 * }} props
 */
export default function Rail({
  lessons,
  activeLessonId,
  onSelectLesson,
  rail,
  completionNext,
  onContinue,
  onQuizAnswer,
  onRetry,
  onCapture,
  onCaptureSkip,
  userName = null,
  capturedEmail = null,
}) {
  const { mode, dots, instructionMd, currentStep, results, graduated, latestAssertionResult } = rail;
  const collapsed = mode === "running";
  // The banner tracks the most recent assertion result so it stays visible
  // while the post-grade capture step is current.
  const assertionResult = latestAssertionResult;
  const showContinue =
    (mode === "instructing" && currentStep?.type === "instruction") ||
    (currentStep?.type === "assertion" && results[currentStep.id]?.pass && !graduated);

  return (
    <aside className={`rail ${collapsed ? "rail-collapsed" : ""}`} data-testid="rail" data-mode={mode}>
      <div className="rail-progress" data-testid="rail-progress">
        {dots.map((dot) => (
          <span key={dot.id} className={`rail-dot rail-dot-${dot.state}`} data-testid="rail-dot" title={dot.id} />
        ))}
      </div>

      {!collapsed && (
        <div className="rail-body">
          <LessonRail lessons={lessons} activeLessonId={activeLessonId} onSelect={onSelectLesson} />

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
              onClick={() => onSelectLesson(completionNext)}
            >
              Next lesson →
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
