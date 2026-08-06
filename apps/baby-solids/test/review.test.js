/**
 * The review gate.
 *
 * Records are drafted from primary sources; that is not the same as a human
 * having read them back. The distinction lives in the data so the UI can show
 * it, rather than in a checklist someone has to remember.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { foods } = JSON.parse(
  readFileSync(new URL("../src/generated/foods.json", import.meta.url), "utf8"),
);

test("reviewedOn is absent or a plain date — never a boolean", () => {
  // A boolean would let "reviewed: true" be set without recording when, which
  // is useless once sources are re-checked after a guideline changes.
  for (const f of foods) {
    if (f.reviewedOn !== undefined) {
      assert.match(f.reviewedOn, /^\d{4}-\d{2}-\d{2}$/, `${f.id} has a malformed reviewedOn`);
    }
  }
});

test("an unreviewed record still carries everything needed to review it", () => {
  // The whole point of the draft state is that a human can check it, so the
  // sources have to be there even before anyone has looked.
  for (const f of foods.filter((x) => !x.reviewedOn)) {
    assert.ok(f.sources.length > 0, `${f.id} is unreviewed and has no sources to check against`);
    for (const s of f.sources) {
      assert.ok(s.url?.startsWith("http"), `${f.id} has a source with no usable URL`);
    }
  }
});

test("any allergen protocol carries its medical gate regardless of review state", () => {
  for (const f of foods) {
    if (f.allergenProtocol) {
      assert.ok(
        f.allergenProtocol.medicalGate?.length > 20,
        `${f.id}: the gate must survive drafting — it is the only medical warning in the dataset`,
      );
    }
  }
});
