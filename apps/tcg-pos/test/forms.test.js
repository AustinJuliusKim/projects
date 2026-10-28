import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildApiKeyBody,
  buildCreditAdjust,
  buildInviteBody,
  buildPinBody,
  buildRegisterBody,
  buildStoreBody,
  pinProblem,
} from "../src/forms.js";
import { isUuid } from "../src/receive.js";

test("pinProblem mirrors the API's trivial-PIN rules", () => {
  assert.equal(pinProblem("284716"), null);
  assert.equal(pinProblem("461938"), null);
  assert.match(pinProblem("12345"), /6 digits/);
  assert.match(pinProblem("12a456"), /6 digits/);
  assert.match(pinProblem("111111"), /repeated/);
  assert.match(pinProblem("121212"), /repeated/);
  assert.match(pinProblem("123123"), /repeated/);
  assert.match(pinProblem("123456"), /run/);
  assert.match(pinProblem("987654"), /run/);
  assert.deepEqual(buildPinBody("284716", "284716"), { body: { pin: "284716" } });
  assert.match(buildPinBody("284716", "284717").error, /match/);
});

test("buildCreditAdjust signs the amount", () => {
  assert.deepEqual(buildCreditAdjust({ direction: "add", amount: "12.50", reason: "goodwill" }), {
    body: { delta_cents: 1250, reason: "goodwill" },
  });
  assert.deepEqual(buildCreditAdjust({ direction: "remove", amount: "$5", reason: " typo " }), {
    body: { delta_cents: -500, reason: "typo" },
  });
  assert.match(buildCreditAdjust({ direction: "add", amount: "0", reason: "x" }).error, /amount/);
  assert.match(buildCreditAdjust({ direction: "add", amount: "abc", reason: "x" }).error, /amount/);
  assert.match(buildCreditAdjust({ direction: "add", amount: "1", reason: "  " }).error, /reason/);
});

test("invite, API key, store and register bodies", () => {
  assert.deepEqual(buildInviteBody({ email: " New@Shop.test ", role: "cashier" }), {
    body: { email: "new@shop.test", role: "cashier" },
  });
  assert.match(buildInviteBody({ email: "nope", role: "cashier" }).error, /email/);
  assert.match(buildInviteBody({ email: "a@b.co", role: null }).error, /role/);
  assert.deepEqual(buildApiKeyBody({ name: " sync ", perms: ["inventory.read", "credit.read"] }), {
    body: { name: "sync", perms: ["credit.read", "inventory.read"] },
  });
  assert.match(buildApiKeyBody({ name: "x", perms: [] }).error, /permission/);
  assert.deepEqual(buildStoreBody({ name: "Shop", locationName: "" }), { body: { name: "Shop" } });
  assert.deepEqual(buildStoreBody({ name: "Shop", locationName: "Main St" }), {
    body: { name: "Shop", location_name: "Main St" },
  });
  const loc = "6f0d4a6e-8d1b-4c4f-9f43-2a7f3f0c9b11";
  assert.deepEqual(buildRegisterBody({ locationId: loc, name: "Front" }, isUuid), {
    body: { location_id: loc, name: "Front" },
  });
  assert.match(buildRegisterBody({ locationId: "x", name: "Front" }, isUuid).error, /location/);
});
