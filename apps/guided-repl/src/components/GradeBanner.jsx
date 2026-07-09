/**
 * Pure pass/retry banner for an evaluated assertion result. Rendered by the
 * Rail during the reflecting/graduated modes — evaluation itself lives in
 * the lesson engine (App evaluates on entering the assertion step).
 */

/**
 * @param {{result: {pass: boolean, detail: string}}} props
 */
export default function GradeBanner({ result }) {
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
