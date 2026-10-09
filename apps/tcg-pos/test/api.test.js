import assert from "node:assert/strict";
import { test } from "node:test";

import { buildQuery } from "../src/api.js";

test("buildQuery drops empty values and encodes", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ location_id: null, printing_id: "" }), "");
  assert.equal(buildQuery({ page: 2, page_size: 50 }), "?page=2&page_size=50");
});
