import test from "node:test";
import assert from "node:assert/strict";
import {
  BabyProfileSchema,
  TimelineEventSchema,
  EnvelopeSchema,
  SCHEMA_VERSION,
} from "../schemas.js";

const ID = "11111111-1111-4111-8111-111111111111";
const BABY = "99999999-9999-4999-8999-999999999999";

const profile = {
  id: BABY,
  name: "Baby",
  birthDate: "2026-03-15",
  timezone: "America/Los_Angeles",
  caregivers: ["Austin", "Christine"],
};

const event = {
  id: ID,
  babyId: BABY,
  ts: "2026-09-14T17:32:00-07:00",
  tz: "America/Los_Angeles",
  kind: "food_exposure",
  payload: { foodId: "sweet-potato", amount: "tasted" },
  source: "baby-solids",
  deviceId: "device-1",
  createdAt: "2026-09-14T17:32:01-07:00",
  revision: 0,
  deleted: false,
};

test("a valid profile and event parse", () => {
  assert.deepEqual(BabyProfileSchema.parse(profile), profile);
  assert.deepEqual(TimelineEventSchema.parse(event), event);
});

test("a naive datetime with no offset is REJECTED, not coerced", () => {
  // This is the guard against inheriting Little Rhythm's timezone corruption:
  // a browser-clock datetime tagged with a configured zone.
  assert.throws(() => TimelineEventSchema.parse({ ...event, ts: "2026-09-14T17:32:00" }));
  assert.throws(() => TimelineEventSchema.parse({ ...event, createdAt: "2026-09-14T17:32:01" }));
});

test("both Z and ±HH:MM offsets are accepted", () => {
  assert.doesNotThrow(() => TimelineEventSchema.parse({ ...event, ts: "2026-09-14T17:32:00Z" }));
  assert.doesNotThrow(() =>
    TimelineEventSchema.parse({ ...event, ts: "2026-09-14T17:32:00.123+09:00" }),
  );
});

test("birthDate rejects a time component — a birth date is a date, not an instant", () => {
  assert.throws(() => BabyProfileSchema.parse({ ...profile, birthDate: "2026-03-15T00:00:00Z" }));
});

test("an unknown kind is accepted so other apps' events survive import", () => {
  assert.doesNotThrow(() => TimelineEventSchema.parse({ ...event, kind: "nap" }));
  assert.doesNotThrow(() => TimelineEventSchema.parse({ ...event, kind: "bottle" }));
});

test("payload passes through unknown keys rather than stripping them", () => {
  const parsed = TimelineEventSchema.parse({
    ...event,
    payload: { foodId: "pear", somethingFromAnotherApp: 42 },
  });
  assert.equal(parsed.payload.somethingFromAnotherApp, 42);
});

test("a negative or fractional revision is rejected", () => {
  assert.throws(() => TimelineEventSchema.parse({ ...event, revision: -1 }));
  assert.throws(() => TimelineEventSchema.parse({ ...event, revision: 1.5 }));
});

test("an envelope with the wrong schemaVersion is rejected loudly", () => {
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: "2026-09-14T17:32:00-07:00",
    exportedBy: "baby-solids",
    profile,
    events: [event],
  };
  assert.doesNotThrow(() => EnvelopeSchema.parse(envelope));
  assert.throws(() => EnvelopeSchema.parse({ ...envelope, schemaVersion: 99 }));
});
