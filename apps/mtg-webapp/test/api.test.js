import assert from "node:assert/strict";
import { test } from "node:test";

import { buildQuery } from "../src/api.js";
import { makeEvent, _pendingCount } from "../src/feedback.js";

test("buildQuery drops empty values and encodes", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ q: null, identity: "" }), "");
  assert.equal(buildQuery({ q: "deals 3 damage", page: 2 }), "?q=deals+3+damage&page=2");
});

test("makeEvent shapes the feedback payload", () => {
  const event = makeEvent(
    "impression",
    "seed-id",
    { oracle_id: "sugg-id", confidence: 0.73 },
    "card_page",
  );
  assert.deepEqual(event, {
    event: "impression",
    seed_oracle_id: "seed-id",
    suggested_oracle_id: "sugg-id",
    confidence: 0.73,
    context: "card_page",
  });
});

test("feedback modules import cleanly outside the browser", () => {
  assert.equal(_pendingCount(), 0);
});
