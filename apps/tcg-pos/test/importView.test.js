import assert from "node:assert/strict";
import { test } from "node:test";

import { canApply, checkFile, sortRows, statusColor, summarize } from "../src/importView.js";

const result = {
  totals: { rows: 9, matched: 5, unmatched: 3, skipped: 1, grains: 4, changed: 4, qty_delta: 9 },
};

test("summarize", () => {
  assert.equal(summarize(result), "5 matched · 3 unmatched · 1 skipped — 4 of 4 items change, +9 qty");
  assert.equal(
    summarize({ totals: { ...result.totals, grains: 1, changed: 0, qty_delta: -2 } }),
    "5 matched · 3 unmatched · 1 skipped — 0 of 1 item change, -2 qty",
  );
  assert.equal(summarize(null), "");
});

test("sortRows puts problems first, then by line", () => {
  const rows = [
    { row: 2, status: "matched" },
    { row: 3, status: "skipped" },
    { row: 4, status: "unmatched" },
    { row: 5, status: "matched" },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.row), [4, 2, 5, 3]);
  assert.deepEqual(sortRows(undefined), []);
  assert.equal(statusColor("unmatched"), "red");
});

test("checkFile and canApply", () => {
  assert.ok(checkFile(null));
  assert.ok(checkFile({ size: 3_000_000 }));
  assert.equal(checkFile({ size: 10 }), null);
  const preview = { dryRun: true, fileKey: "a", result };
  assert.equal(canApply(preview, "a"), true);
  assert.equal(canApply(preview, "b"), false); // different file than previewed
  assert.equal(canApply({ ...preview, dryRun: false }, "a"), false); // already applied
  assert.equal(
    canApply({ ...preview, result: { totals: { ...result.totals, changed: 0 } } }, "a"),
    false,
  );
  assert.equal(canApply(null, "a"), false);
});
