/**
 * FROZEN cross-app contract. Four consumers depend on these shapes:
 *   1. the S3 sync payload (one object per device)
 *   2. the JSON export/import envelope
 *   3. the Little Rhythm convergence contract
 *   4. the eventual relational import
 *
 * Changing a field name or type here touches all four. Add new optional
 * fields rather than reshaping existing ones.
 *
 * @typedef {{id: string, name: string, birthDate: string, timezone: string,
 *            caregivers: string[]}} BabyProfile
 * @typedef {{id: string, babyId: string, ts: string, tz: string, kind: string,
 *            payload: object, source: string, deviceId: string,
 *            createdAt: string, revision: number, deleted: boolean}} TimelineEvent
 * @typedef {{schemaVersion: number, exportedAt: string, exportedBy: string,
 *            profile: BabyProfile, events: TimelineEvent[]}} Envelope
 */

import { z } from "zod";

export const SCHEMA_VERSION = 1;

/**
 * ISO-8601 that MUST carry an explicit offset (`Z` or `±HH:MM`).
 *
 * This regex is the single most load-bearing line in the package. A naive
 * local datetime is rejected rather than coerced, because "build a naive
 * datetime from the browser clock, then tag it with a configured zone" is
 * the exact bug that silently corrupts every exported event in Little
 * Rhythm. Storing the instant plus the zone separately makes that
 * unrepresentable instead of merely discouraged.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Calendar date with no time component — a birth date is a date, not an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Written with a regex rather than `.uuid()` so the package doesn't depend on Zod's evolving string-format API. */
const uuid = () => z.string().regex(UUID, "must be a UUID");
const instant = () =>
  z.string().regex(ISO_WITH_OFFSET, "must be ISO-8601 with an explicit offset (Z or ±HH:MM)");

export const BabyProfileSchema = z.object({
  id: uuid(),
  name: z.string().min(1),
  birthDate: z.string().regex(DATE_ONLY, "must be YYYY-MM-DD with no time component"),
  timezone: z.string().min(1),
  caregivers: z.array(z.string().min(1)),
});

/**
 * Kinds this app writes and renders. Deliberately NOT the set the schema
 * accepts — see below.
 */
export const KNOWN_KINDS = ["food_exposure", "reaction", "note"];

export const TimelineEventSchema = z.object({
  id: uuid(),
  babyId: uuid(),
  ts: instant(),
  tz: z.string().min(1),
  /**
   * An open string, not an enum. The discriminator exists so a nap or bottle
   * event from another app is a *value* rather than a schema change — and
   * import must round-trip unknown kinds intact rather than dropping them,
   * or the convergence contract silently loses the other app's data. Use
   * KNOWN_KINDS to decide what this app renders.
   */
  kind: z.string().min(1),
  payload: z.object({}).passthrough(),
  source: z.string().min(1),
  deviceId: z.string().min(1),
  createdAt: instant(),
  revision: z.number().int().min(0),
  /** Tombstone. Deletes are never absences — see merge.js. */
  deleted: z.boolean(),
});

export const EnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: instant(),
  exportedBy: z.string().min(1),
  profile: BabyProfileSchema,
  events: z.array(TimelineEventSchema),
});

/** @param {unknown} v @returns {TimelineEvent} */
export function parseEvent(v) {
  return TimelineEventSchema.parse(v);
}

/** @param {unknown} v @returns {Envelope} */
export function parseEnvelope(v) {
  return EnvelopeSchema.parse(v);
}
