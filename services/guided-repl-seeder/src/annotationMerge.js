/**
 * L2 "Why did it do that?" is a step-through replay of L1's `constrained`
 * run with hand-authored annotations attached to specific beats — no live
 * recording. This merges a set of {index, annotation} entries onto a copy
 * of a source fixture and rewrites its lessonId/branchId.
 */

import { validateFixture } from "@guided-repl/protocol";

/**
 * @typedef {{index: number, annotation: {title: string, body: string}}} AnnotationSpec
 */

/**
 * @param {object} sourceFixture a validated FixtureEnvelope to merge from
 * @param {{lessonId: string, branchId: string, annotations: AnnotationSpec[]}} opts
 * @returns {object} a new, validated FixtureEnvelope
 */
export function mergeAnnotations(sourceFixture, opts) {
  const { lessonId, branchId, annotations } = opts;
  const events = sourceFixture.events.map((e) => ({ ...e }));

  for (const { index, annotation } of annotations) {
    if (index < 0 || index >= events.length) {
      throw new Error(`mergeAnnotations: annotation index ${index} out of range (0..${events.length - 1})`);
    }
    const target = events[index];
    if (!("frame" in target)) {
      throw new Error(`mergeAnnotations: events[${index}] is an awaitClient marker, not an annotatable frame event`);
    }
    events[index] = { ...target, annotation };
  }

  const merged = {
    ...sourceFixture,
    lessonId,
    branchId,
    recordedAt: new Date().toISOString(),
    events,
  };

  validateFixture(merged);
  return merged;
}
