import { test } from "node:test";
import assert from "node:assert/strict";
import { isClean } from "./moderation.mjs";

test("isClean passes ordinary food labels", () => {
  assert.equal(isClean("Pizza"), true);
  assert.equal(isClean("Pho King Good"), true);
  assert.equal(isClean("Shakshuka"), true);
  assert.equal(isClean(""), true);
  assert.equal(isClean(null), true);
});

test("isClean catches profanity, including light obfuscation", () => {
  assert.equal(isClean("fuck"), false);
  assert.equal(isClean("go FuCk yourself diner"), false);
  assert.equal(isClean("fuuuck burgers"), false);
});
