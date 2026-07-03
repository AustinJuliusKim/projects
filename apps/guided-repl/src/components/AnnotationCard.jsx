/**
 * Shown next to the transcript when state.annotation is set — step-mode
 * playback (lesson.playback === "step") pauses at an annotated beat and
 * this card explains the beat that's currently paused. Next resumes
 * playback via useSession().next().
 */

/**
 * @param {{annotation: {title: string, body: string}|null, onNext: () => void}} props
 */
export default function AnnotationCard({ annotation, onNext }) {
  if (!annotation) return null;

  return (
    <div className="annotation-card" data-testid="annotation-card">
      <h3 className="annotation-title">{annotation.title}</h3>
      <p className="annotation-body">{annotation.body}</p>
      <button type="button" className="step-next" data-testid="step-next" onClick={onNext}>
        Next
      </button>
    </div>
  );
}
