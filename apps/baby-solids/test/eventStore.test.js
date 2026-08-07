/**
 * The event store writes timestamps; the frozen schema rejects any that lack
 * an explicit offset. If those two disagree, every single log write fails at
 * runtime — so they are checked against each other here rather than assumed
 * to match.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TimelineEventSchema } from "@baby/core";
import { isoWithOffset } from "../src/store/eventStore.js";

test("isoWithOffset produces a timestamp the frozen schema accepts", () => {
  const event = {
    id: "11111111-1111-4111-8111-111111111111",
    babyId: "99999999-9999-4999-8999-999999999999",
    ts: isoWithOffset(),
    tz: "America/Los_Angeles",
    kind: "food_exposure",
    payload: { foodId: "pear" },
    source: "baby-solids",
    deviceId: "d1",
    createdAt: isoWithOffset(),
    revision: 0,
    deleted: false,
  };
  assert.doesNotThrow(() => TimelineEventSchema.parse(event));
});

test("isoWithOffset carries a real offset, never a bare naive string", () => {
  const s = isoWithOffset(new Date("2026-09-14T17:32:00Z"));
  assert.match(s, /(Z|[+-]\d{2}:\d{2})$/, "must end in Z or ±HH:MM");
  assert.ok(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s), "must not be naive");
});

test("isoWithOffset preserves the instant it was given", () => {
  const instant = new Date("2026-09-14T17:32:00Z");
  // Round-tripping through the formatted string must land on the same moment,
  // regardless of the machine's timezone. This is the property that makes an
  // event logged in Los Angeles readable from a phone in Seoul.
  assert.equal(new Date(isoWithOffset(instant)).getTime(), instant.getTime());
});
