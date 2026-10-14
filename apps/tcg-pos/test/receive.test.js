import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReceiveBody,
  centsToInput,
  finishOptions,
  isUuid,
  parseDollars,
  printingLabel,
} from "../src/receive.js";

const LOC = "6f1c7c1e-1111-4a5b-8c9d-0123456789ab";
const PRINTING = "e768c957-3a1f-42f5-853a-96942f645df5";

test("parseDollars turns dollar strings into integer cents without float math", () => {
  assert.equal(parseDollars("12.34"), 1234);
  assert.equal(parseDollars("$1,234.5"), 123450);
  assert.equal(parseDollars("7"), 700);
  assert.equal(parseDollars("0.29"), 29);
  assert.equal(parseDollars("1."), 100);
  assert.equal(parseDollars(""), null);
  assert.equal(parseDollars("  "), null);
  for (const bad of ["abc", "1.234", "-1", "1e3", "99999999999"]) {
    assert.equal(parseDollars(bad), undefined, bad);
  }
});

test("centsToInput is the inverse for the price field", () => {
  assert.equal(centsToInput(1275), "12.75");
  assert.equal(centsToInput(5), "0.05");
  assert.equal(centsToInput(null), "");
  assert.equal(centsToInput(1.5), "");
  assert.equal(parseDollars(centsToInput(123456)), 123456);
});

test("finishOptions follows the printing, in canonical order", () => {
  assert.deepEqual(finishOptions({ finishes: ["foil", "nonfoil"] }), ["nonfoil", "foil"]);
  assert.deepEqual(finishOptions({ finishes: ["etched"] }), ["etched"]);
  assert.deepEqual(finishOptions(null), ["nonfoil", "foil", "etched"]);
  assert.deepEqual(finishOptions({ finishes: ["glossy"] }), ["nonfoil", "foil", "etched"]);
});

test("printingLabel and isUuid", () => {
  assert.equal(
    printingLabel({ set_code: "m11", set_name: "Magic 2011", collector_number: "149" }),
    "Magic 2011 (M11) #149",
  );
  assert.ok(isUuid(LOC));
  assert.ok(!isUuid("abc"));
  assert.ok(!isUuid(undefined));
});

test("buildReceiveBody validates and builds the adjust body", () => {
  const form = {
    locationId: LOC,
    printingId: PRINTING,
    condition: "LP",
    finish: "foil",
    qty: 3,
    price: "12.75",
  };
  assert.deepEqual(buildReceiveBody(form).body, {
    location_id: LOC,
    printing_id: PRINTING,
    condition: "LP",
    finish: "foil",
    delta: 3,
    reason: "received",
    channel: "adjustment",
    price_cents: 1275,
  });
  // Blank price → no price_cents (stays unpriced, not $0).
  assert.equal("price_cents" in buildReceiveBody({ ...form, price: "" }).body, false);
  for (const bad of [
    { locationId: "nope" },
    { printingId: null },
    { condition: "Mint" },
    { finish: "galaxy" },
    { qty: 0 },
    { qty: 1.5 },
    { qty: "" },
    { price: "1.234" },
  ]) {
    assert.ok(buildReceiveBody({ ...form, ...bad }).error, JSON.stringify(bad));
  }
});
