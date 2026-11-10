import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/handler.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const valid = () => ({
  email: "Owner@Shop.com",
  firstName: "Sam",
  businessType: "retail",
  businessName: "Sam's Shop",
  city: "pasadena",
  consent: true,
});
const ev = (body, extra = {}) => ({ body: typeof body === "string" ? body : JSON.stringify(body), ...extra });

function setup({ sendWelcomeOn = false, saveErr, sendErr } = {}) {
  const saved = [];
  const sent = [];
  const handler = createHandler({
    saveLead: async (l) => {
      if (saveErr) throw saveErr;
      saved.push(l);
    },
    sendWelcome: async (l) => {
      sent.push(l);
      if (sendErr) throw sendErr;
    },
    config: { sendWelcome: sendWelcomeOn },
    now: () => NOW,
  });
  return { handler, saved, sent };
}

function quiet(fn) {
  return async () => {
    const orig = console.error;
    const logs = [];
    console.error = (...x) => logs.push(JSON.stringify(x));
    try {
      return await fn(logs);
    } finally {
      console.error = orig;
    }
  };
}

test("happy path returns 201 and saves normalized lead with timestamps", async () => {
  const { handler, saved, sent } = setup();
  const res = await handler(ev(valid()));
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].email, "owner@shop.com");
  assert.equal(saved[0].createdAt, NOW.toISOString());
  assert.equal(saved[0].updatedAt, NOW.toISOString());
  assert.equal(sent.length, 0);
});

test("missing fields -> 400 with field keys, nothing saved", async () => {
  const { handler, saved } = setup();
  const res = await handler(ev({ email: "a@b.com" }));
  assert.equal(res.statusCode, 400);
  const b = JSON.parse(res.body);
  assert.equal(b.error, "invalid");
  assert.deepEqual(Object.keys(b.fields).sort(), ["businessName", "businessType", "city", "consent", "firstName"]);
  assert.equal(saved.length, 0);
});

test("bad enum and consent false -> 400", async () => {
  const { handler } = setup();
  const res = await handler(ev({ ...valid(), city: "mars", consent: false }));
  assert.equal(res.statusCode, 400);
  const f = JSON.parse(res.body).fields;
  assert.ok(f.city && f.consent);
});

test("non-object JSON body -> 400 invalid", async () => {
  const { handler } = setup();
  const res = await handler(ev("[1,2]"));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid");
});

test("honeypot returns 200 without saving or sending", async () => {
  const { handler, saved, sent } = setup({ sendWelcomeOn: true });
  const res = await handler(ev({ ...valid(), company: "Bot Inc" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(saved.length + sent.length, 0);
});

test("empty honeypot is fine", async () => {
  const { handler, saved } = setup();
  const res = await handler(ev({ ...valid(), company: "" }));
  assert.equal(res.statusCode, 201);
  assert.equal(saved.length, 1);
  assert.equal("company" in saved[0], false);
});

test("invalid JSON -> 400 invalid_json", async () => {
  const { handler } = setup();
  for (const b of ["{nope", "", undefined]) {
    const res = await handler({ body: b });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "invalid_json" });
  }
});

test("base64 body is decoded", async () => {
  const { handler, saved } = setup();
  const body = Buffer.from(JSON.stringify(valid())).toString("base64");
  const res = await handler({ body, isBase64Encoded: true });
  assert.equal(res.statusCode, 201);
  assert.equal(saved[0].firstName, "Sam");
});

test("oversized body -> 413", async () => {
  const { handler, saved } = setup();
  const res = await handler(ev({ ...valid(), pad: "x".repeat(9000) }));
  assert.equal(res.statusCode, 413);
  assert.equal(saved.length, 0);
});

test("welcome email sent when enabled", async () => {
  const { handler, sent } = setup({ sendWelcomeOn: true });
  const res = await handler(ev(valid()));
  assert.equal(res.statusCode, 201);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, "owner@shop.com");
});

test("welcome failure is logged and still 201", quiet(async (logs) => {
  const { handler, sent } = setup({ sendWelcomeOn: true, sendErr: new Error("ses down") });
  const res = await handler(ev(valid()));
  assert.equal(res.statusCode, 201);
  assert.equal(sent.length, 1);
  assert.ok(logs.length >= 1);
}));

test("saveLead failure -> 500 and log omits email", quiet(async (logs) => {
  const { handler, sent } = setup({ sendWelcomeOn: true, saveErr: new Error("boom") });
  const res = await handler(ev(valid()));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: "server_error" });
  assert.equal(sent.length, 0);
  assert.ok(logs.length >= 1);
  assert.ok(!logs.join("").toLowerCase().includes("owner@shop.com"));
}));

test("website and utm normalization reach saveLead", async () => {
  const { handler, saved } = setup();
  await handler(ev({ ...valid(), website: "shop.com", utm: { utm_source: "ig", junk: "x" } }));
  assert.equal(saved[0].website, "https://shop.com");
  assert.deepEqual(saved[0].utm, { utm_source: "ig" });
});
