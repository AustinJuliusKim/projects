/**
 * Rail-only quiz card (Lesson Engine Spec §3: quizzes are non-diegetic —
 * never rendered in the run surface). Radio choices + Submit; a wrong
 * answer is soft — re-answerable with feedback.
 */

import { useState } from "react";

/**
 * @param {{step: {id: string, question: string, options: string[], answerIdx: number, explainMd?: string}, onAnswer: (stepId: string, answerIdx: number) => void}} props
 */
export default function QuizCard({ step, onAnswer }) {
  const [selected, setSelected] = useState(null);
  const [wrong, setWrong] = useState(false);

  function submit() {
    if (selected === null) return;
    setWrong(selected !== step.answerIdx);
    onAnswer(step.id, selected);
  }

  return (
    <div className="quiz-card" data-testid="quiz-card">
      <p className="quiz-question">{step.question}</p>
      <div className="quiz-choices">
        {step.options.map((choice, i) => (
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
      {wrong && <div className="quiz-feedback">Not quite — try another answer.</div>}
    </div>
  );
}
