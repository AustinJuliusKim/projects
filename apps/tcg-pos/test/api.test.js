import assert from "node:assert/strict";
import { test } from "node:test";

import { authHeaders, buildQuery, errorMessage } from "../src/api.js";

test("buildQuery drops empty values and encodes", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ location_id: null, printing_id: "" }), "");
  assert.equal(buildQuery({ page: 2, page_size: 50 }), "?page=2&page_size=50");
});

test("errorMessage reads FastAPI string and validation details", () => {
  assert.equal(errorMessage(409, { detail: "would go negative" }), "would go negative");
  assert.equal(
    errorMessage(422, { detail: [{ loc: ["body", "price_cents"], msg: "too big" }] }),
    "price_cents: too big",
  );
  assert.equal(errorMessage(502, {}), "API error 502");
});

test("authHeaders sends only what is set", () => {
  assert.deepEqual(authHeaders({}), {});
  assert.deepEqual(authHeaders({ tenantId: "t", actor: "a" }), {
    "X-Tenant-Id": "t",
    "X-Actor": "a",
  });
});
