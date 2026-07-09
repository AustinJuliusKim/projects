/**
 * Derives the lesson-kind chip (quiz vs check) from the lesson's authored
 * steps: a quiz step → quiz chip with ? glyph; otherwise → check chip with
 * ✓ glyph.
 *
 * @param {Array<object>|undefined} steps - Authored steps from the compiled lesson
 * @returns {{kind: "quiz"|"check", label: string, glyph: string}}
 */
export function lessonKind(steps) {
  if (Array.isArray(steps) && steps.some((s) => s.type === "quiz")) {
    return { kind: "quiz", label: "Quiz", glyph: "?" };
  }
  return { kind: "check", label: "Check", glyph: "✓" };
}
