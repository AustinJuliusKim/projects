import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLead } from "../src/validate.js";

const base = () => ({
  email: "  Jane@Example.COM ",
  firstName: " Jane ",
  businessType: "restaurant",
  businessName: "Jane's Diner",
  city: "glendale",
  consent: true,
});

test("happy path trims and lowercases", () => {
  const r = validateLead(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.lead, {
    email: "jane@example.com",
    firstName: "Jane",
    businessType: "restaurant",
    businessName: "Jane's Diner",
    city: "glendale",
    consent: true,
  });
});

test("rejects non-object bodies", () => {
  for (const b of [null, undefined, "x", 5, [], true]) {
    const r = validateLead(b);
    assert.equal(r.ok, false);
    assert.ok(r.errors.body);
  }
});

test("missing required fields report each key", () => {
  const r = validateLead({});
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ["businessName", "businessType", "city", "consent", "email", "firstName"]);
});

test("email validation", () => {
  for (const e of ["nope", "a@b", "a b@c.com", "@c.com", "a@@c.com", `${"a".repeat(250)}@x.com`]) {
    assert.ok(validateLead({ ...base(), email: e }).errors?.email, e);
  }
  assert.equal(validateLead({ ...base(), email: "a+tag@sub.example.co" }).ok, true);
});

test("length limits", () => {
  assert.ok(validateLead({ ...base(), firstName: "a".repeat(81) }).errors.firstName);
  assert.ok(validateLead({ ...base(), businessName: "a".repeat(121) }).errors.businessName);
  assert.equal(validateLead({ ...base(), firstName: "a".repeat(80), businessName: "b".repeat(120) }).ok, true);
});

test("enum checks", () => {
  assert.ok(validateLead({ ...base(), businessType: "bank" }).errors.businessType);
  assert.ok(validateLead({ ...base(), city: "nyc" }).errors.city);
  for (const c of ["glendale", "pasadena", "burbank", "sfv", "la-other", "other"]) {
    assert.equal(validateLead({ ...base(), city: c }).ok, true);
  }
});

test("consent must be literally true", () => {
  for (const c of [false, "true", 1, undefined]) {
    assert.ok(validateLead({ ...base(), consent: c }).errors.consent);
  }
});

test("strips control characters", () => {
  const r = validateLead({ ...base(), firstName: "Ja\u0000n\u0007e\n" });
  assert.equal(r.lead.firstName, "Jane");
});

test("website normalization", () => {
  const w = (website) => validateLead({ ...base(), website });
  assert.equal(w("example.com").lead.website, "https://example.com");
  assert.equal(w("http://example.com/a").lead.website, "http://example.com/a");
  assert.equal(w("https://example.com").lead.website, "https://example.com");
  assert.equal(w("example.com:8080/x").lead.website, "https://example.com:8080/x");
  assert.equal("website" in w("").lead, false);
  assert.equal("website" in validateLead(base()).lead, false);
  for (const bad of ["javascript:alert(1)", "ftp://example.com", "localhost", "not a url", `https://example.com/${"a".repeat(200)}`, 42]) {
    assert.ok(w(bad).errors?.website, String(bad));
  }
});

test("utm filtering drops unknown keys and keeps known", () => {
  const r = validateLead({ ...base(), utm: { utm_source: "ig", utm_medium: "social", evil: "x", utm_term: "" } });
  assert.deepEqual(r.lead.utm, { utm_source: "ig", utm_medium: "social" });
});

test("utm limits and shape", () => {
  assert.ok(validateLead({ ...base(), utm: { utm_source: "a".repeat(101) } }).errors.utm);
  assert.ok(validateLead({ ...base(), utm: { utm_source: 5 } }).errors.utm);
  assert.ok(validateLead({ ...base(), utm: "x" }).errors.utm);
  assert.equal("utm" in validateLead({ ...base(), utm: { foo: "bar" } }).lead, false);
});
