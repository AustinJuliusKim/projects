/**
 * Derives lesson-kind chip (quiz vs check) from the lesson's assertion object.
 * Reads the assertion.type field: "quiz" → quiz chip with ? glyph;
 * "file-contains" or undefined → check chip with ✓ glyph.
 *
 * @param {object|undefined} assertion - Raw assertion object from lessons.json
 * @returns {{kind: "quiz"|"check", label: string, glyph: string}}
 */
export function lessonKind(assertion) {
  if (assertion && assertion.type === "quiz") {
    return { kind: "quiz", label: "Quiz", glyph: "?" };
  }
  return { kind: "check", label: "Check", glyph: "✓" };
}
