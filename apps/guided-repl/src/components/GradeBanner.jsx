/**
 * After the session reaches "done", runs assertionEvaluator against the
 * final {files, messages} and renders a pass or soft-retry banner. Quiz
 * assertions render a QuizCard (radio choices + submit) instead, gating the
 * pass banner behind a correct answer; a wrong answer is soft — re-answerable.
 */

import { useMemo, useState } from "react";
import { evaluate } from "../grading/assertionEvaluator.js";

/**
 * @param {{assertion: object, files: import("../lib/virtualFs.js").VFiles, messages: Array<object>, onPass: () => void}} props
 */
function QuizCard({ assertion, files, messages, onPass }) {
  const [selected, setSelected] = useState(null);
  const [result, setResult] = useState(null);

  function submit() {
    const outcome = evaluate(assertion, { files, messages, quizAnswer: selected });
    setResult(outcome);
    if (outcome.pass) onPass();
  }

  return (
    <div className="quiz-card" data-testid="quiz-card">
      <p className="quiz-question">{assertion.question}</p>
      <div className="quiz-choices">
        {assertion.choices.map((choice, i) => (
          <label className="quiz-choice" data-testid="quiz-choice" key={i}>
            <input type="radio" name="quiz-answer" checked={selected === i} onChange={() => setSelected(i)} />
            {choice}
          </label>
        ))}
      </div>
      <button
        type="button"
        className="quiz-submit"
        data-testid="quiz-submit"
        disabled={selected === null}
        onClick={submit}
      >
        Submit
      </button>
      {result && !result.pass && <div className="quiz-feedback">{result.detail}</div>}
    </div>
  );
}

/**
 * @param {{assertion: object, files: import("../lib/virtualFs.js").VFiles, messages: Array<object>}} props
 */
export default function GradeBanner({ assertion, files, messages }) {
  const [quizPassed, setQuizPassed] = useState(false);

  // Hooks must run unconditionally: this memo sits above the quiz
  // early-return so the hook order is identical on every render.
  const result = useMemo(
    () => (assertion.type === "quiz" ? { pass: true, detail: "Correct" } : evaluate(assertion, { files, messages })),
    [assertion, files, messages],
  );

  if (assertion.type === "quiz" && !quizPassed) {
    return <QuizCard assertion={assertion} files={files} messages={messages} onPass={() => setQuizPassed(true)} />;
  }

  return (
    <div className={`grade-banner ${result.pass ? "grade-banner-pass" : "grade-banner-retry"}`} data-testid="grade-banner">
      {result.pass ? (
        <>
          <strong>Lesson complete ✓</strong>
          <span>{result.detail}</span>
        </>
      ) : (
        <>
          <strong>Not quite yet</strong>
          <span>{result.detail}</span>
        </>
      )}
    </div>
  );
}
