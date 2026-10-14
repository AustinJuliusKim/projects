import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  ApiError,
  autocomplete,
  autocompleteItems,
  buildQuery,
  createOrder,
  errorMessage,
  getCard,
  getOrder,
  getStore,
  quoteCart,
  searchStore,
  storePath,
} from "../src/api.js";
import { autocompleteList, order409 } from "./fixtures.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

test("buildQuery drops empties and repeats array / pair keys", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ q: "", page: null }), "");
  assert.equal(buildQuery({ q: "sol ring", page: 2 }), "?q=sol+ring&page=2");
  assert.equal(buildQuery({ set: ["lea", "leb"] }), "?set=lea&set=leb");
  assert.equal(
    buildQuery([
      ["q", "t:dragon c:r"],
      ["colors", "R"],
      ["colors", "G"],
    ]),
    "?q=t%3Adragon+c%3Ar&colors=R&colors=G",
  );
});

test("storePath encodes the slug and requires one", () => {
  assert.equal(storePath("demo"), "/v1/storefront/demo");
  assert.equal(storePath("demo", "/search"), "/v1/storefront/demo/search");
  assert.equal(storePath("a b"), "/v1/storefront/a%20b");
  assert.throws(() => storePath(""));
});

test("errorMessage reads string, validation and {message, issues} details", () => {
  assert.equal(errorMessage(404, { detail: "no such order" }), "no such order");
  assert.equal(
    errorMessage(422, { detail: [{ loc: ["body", "customer", "email"], msg: "bad" }] }),
    "customer.email: bad",
  );
  assert.equal(errorMessage(409, order409), "some lines can't be reserved");
  assert.match(errorMessage(429, {}), /Too many requests/);
  assert.equal(errorMessage(502, {}), "API error 502");
  assert.equal(errorMessage(500, null), "API error 500");
});

test("endpoint paths and params", async () => {
  const calls = mockFetch(200, {});
  await getStore("demo");
  await searchStore("demo", [
    ["q", "bolt"],
    ["mode", "stock"],
    ["set", "m10"],
    ["set", "lea"],
  ]);
  await getCard("demo", "abc-123");
  await getOrder("demo", "ord-1", "ABC234");
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.url]),
    [
      ["GET", "/api/v1/storefront/demo"],
      ["GET", "/api/v1/storefront/demo/search?q=bolt&mode=stock&set=m10&set=lea"],
      ["GET", "/api/v1/storefront/demo/cards/abc-123"],
      ["GET", "/api/v1/storefront/demo/orders/ord-1?code=ABC234"],
    ],
  );
});

test("POSTs send JSON bodies", async () => {
  const calls = mockFetch(201, { id: "o" });
  const body = { lines: [{ inventory_item_id: "i", qty: 1 }] };
  await quoteCart("demo", body);
  await createOrder("demo", { idempotency_key: "k".repeat(10), customer: {}, lines: body.lines });
  assert.equal(calls[0].url, "/api/v1/storefront/demo/cart/quote");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
  assert.equal(calls[1].url, "/api/v1/storefront/demo/orders");
  assert.equal(calls[1].init.method, "POST");
});

test("a 409 becomes an ApiError carrying the per-line issues", async () => {
  mockFetch(409, order409);
  await assert.rejects(
    createOrder("demo", {}),
    (e) =>
      e instanceof ApiError &&
      e.status === 409 &&
      e.message === "some lines can't be reserved" &&
      e.issues.length === 2 &&
      e.issues[0].status === "insufficient",
  );
  mockFetch(404, { detail: "no such order" });
  await assert.rejects(
    getOrder("demo", "x", "y"),
    (e) => e.status === 404 && e.issues.length === 0 && e.message === "no such order",
  );
});

test("autocomplete accepts the bare list or a wrapped one", async () => {
  assert.deepEqual(autocompleteItems(autocompleteList), autocompleteList);
  assert.deepEqual(autocompleteItems({ results: autocompleteList }), autocompleteList);
  assert.deepEqual(autocompleteItems({ suggestions: autocompleteList }), autocompleteList);
  assert.deepEqual(autocompleteItems(null), []);
  const calls = mockFetch(200, autocompleteList);
  assert.equal((await autocomplete("demo", "light")).length, 2);
  assert.equal(calls[0].url, "/api/v1/storefront/demo/autocomplete?q=light");
});
