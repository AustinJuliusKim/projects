import test from "node:test";
import assert from "node:assert/strict";

import {
  USER_NAME_TOKEN,
  MAX_USER_NAME_LENGTH,
  DEFAULT_USER_NAME,
  USER_NAME_RE,
  sanitizeUserName,
  escapeHtml,
  interpolateUserName,
} from "../interpolate.js";

test("constants", () => {
  assert.equal(USER_NAME_TOKEN, "{{userName}}");
  assert.equal(MAX_USER_NAME_LENGTH, 30);
  assert.equal(DEFAULT_USER_NAME, "Demo User");
});

test("sanitizeUserName accepts plain names, trimming and collapsing whitespace", () => {
  assert.equal(sanitizeUserName("Ada"), "Ada");
  assert.equal(sanitizeUserName("  Ada   Lovelace  "), "Ada Lovelace");
  assert.equal(sanitizeUserName("O'Brien"), "O'Brien");
  assert.equal(sanitizeUserName("Jean-Luc"), "Jean-Luc");
  assert.equal(sanitizeUserName("Dr. Who 2"), "Dr. Who 2");
  assert.equal(sanitizeUserName("Zoë"), "Zoë");
  assert.equal(sanitizeUserName("李明"), "李明");
});

test("sanitizeUserName truncates to 30 chars post-trim", () => {
  const long = "A".repeat(50);
  assert.equal(sanitizeUserName(long), "A".repeat(MAX_USER_NAME_LENGTH));
  assert.equal(sanitizeUserName(long).length, 30);
});

test("sanitizeUserName rejects HTML/script payloads", () => {
  assert.equal(sanitizeUserName("<script>alert(1)</script>"), null);
  assert.equal(sanitizeUserName('"><img src=x onerror=alert(1)>'), null);
  assert.equal(sanitizeUserName("Ada <b>bold</b>"), null);
  assert.equal(sanitizeUserName("a&b"), null);
  assert.equal(sanitizeUserName("x=y"), null);
});

test("sanitizeUserName rejects emoji-only and leading-punctuation input", () => {
  assert.equal(sanitizeUserName("🔥🔥🔥"), null);
  assert.equal(sanitizeUserName("'Ada"), null); // must start with letter/digit
  assert.equal(sanitizeUserName("-dash"), null);
});

test("sanitizeUserName rejects empty and non-string input", () => {
  assert.equal(sanitizeUserName(""), null);
  assert.equal(sanitizeUserName("   "), null);
  assert.equal(sanitizeUserName(null), null);
  assert.equal(sanitizeUserName(undefined), null);
  assert.equal(sanitizeUserName(42), null);
});

test("USER_NAME_RE never admits HTML metacharacters", () => {
  // Apostrophe is the one allowed quote-ish char (O'Brien) — escapeHtml
  // covers it at markup sinks. Everything else must be rejected outright.
  for (const c of ["<", ">", "&", '"', "=", "/", "`"]) {
    assert.equal(USER_NAME_RE.test(`Ada${c}x`), false, `metachar ${c}`);
  }
  assert.equal(USER_NAME_RE.test("O'Brien"), true);
});

test("escapeHtml escapes all five metacharacters", () => {
  assert.equal(escapeHtml(`<b a="x" b='y'>&`), "&lt;b a=&quot;x&quot; b=&#39;y&#39;&gt;&amp;");
  assert.equal(escapeHtml("plain"), "plain");
});

test("interpolateUserName replaces every token in text mode", () => {
  assert.equal(
    interpolateUserName("Hi {{userName}}, welcome {{userName}}!", "Ada"),
    "Hi Ada, welcome Ada!",
  );
});

test("interpolateUserName defaults on null/undefined/empty name (skip path)", () => {
  assert.equal(interpolateUserName("Hi {{userName}}", null), "Hi Demo User");
  assert.equal(interpolateUserName("Hi {{userName}}", undefined), "Hi Demo User");
  assert.equal(interpolateUserName("Hi {{userName}}", ""), "Hi Demo User");
});

test("interpolateUserName passes token-free text through unchanged", () => {
  const s = "no tokens here";
  assert.equal(interpolateUserName(s, "Ada"), s);
  assert.equal(interpolateUserName("", "Ada"), "");
});

test("interpolateUserName html mode escapes the value", () => {
  // The allowlist blocks metacharacters at capture, but html mode must still
  // escape defensively — apostophes matter inside attributes.
  assert.equal(
    interpolateUserName("<h1>{{userName}}</h1>", "O'Brien", { html: true }),
    "<h1>O&#39;Brien</h1>",
  );
  assert.equal(
    interpolateUserName("<h1>{{userName}}</h1>", "<img onerror=x>", { html: true }),
    "<h1>&lt;img onerror=x&gt;</h1>",
  );
});

test("interpolateUserName text mode leaves the value unescaped", () => {
  assert.equal(interpolateUserName("Hi {{userName}}", "O'Brien"), "Hi O'Brien");
});

test("interpolateUserName tolerates non-string input", () => {
  assert.equal(interpolateUserName(null, "Ada"), null);
  assert.equal(interpolateUserName(undefined, "Ada"), undefined);
});
