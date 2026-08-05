// router.mjs: Host-based routing decisions only. Keep this in sync with the
// inline copy in ../edge-preview-router.yaml (see router.mjs's header
// comment for why there are two copies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeRequest } from "./router.mjs";

const CONFIG = {
  previewHost: "preview.choices.austinjuliuskim.com",
  apiDomain: "abcd1234.lambda-url.us-west-2.on.aws",
  apiSecret: "test-api-secret",
  s3Domain: "choiceswebapp-preview-sitebucket-xyz.s3.us-west-2.amazonaws.com",
  s3Secret: "test-s3-secret",
};

function cfRequest({ uri = "/", host = CONFIG.previewHost } = {}) {
  return {
    uri,
    headers: {
      host: [{ key: "Host", value: host }],
    },
  };
}

test("non-preview Host passes through untouched", () => {
  const request = cfRequest({ host: "choices.austinjuliuskim.com", uri: "/api/getState" });
  const before = JSON.parse(JSON.stringify(request));
  const result = routeRequest(request, CONFIG);
  assert.deepEqual(result, before);
  assert.equal(result.origin, undefined);
});

test("preview Host + static path routes to preview's S3 bucket with the cache-key prefix stripped", () => {
  const request = cfRequest({ uri: "/__preview/index.html" });
  const result = routeRequest(request, CONFIG);
  assert.equal(result.uri, "/index.html");
  assert.equal(result.origin.custom.domainName, CONFIG.s3Domain);
  assert.deepEqual(result.origin.custom.customHeaders.referer, [
    { key: "Referer", value: CONFIG.s3Secret },
  ]);
  assert.deepEqual(result.headers.host, [{ key: "host", value: CONFIG.s3Domain }]);
});

test("preview Host + bare /__preview root strips to / (not empty string)", () => {
  const request = cfRequest({ uri: "/__preview" });
  const result = routeRequest(request, CONFIG);
  assert.equal(result.uri, "/");
});

test("preview Host + /api* routes to preview's Function URL with x-origin-verify", () => {
  const request = cfRequest({ uri: "/api/getState" });
  const result = routeRequest(request, CONFIG);
  assert.equal(result.uri, "/api/getState"); // untouched -- only the static path strips a prefix
  assert.equal(result.origin.custom.domainName, CONFIG.apiDomain);
  assert.deepEqual(result.origin.custom.customHeaders["x-origin-verify"], [
    { key: "x-origin-verify", value: CONFIG.apiSecret },
  ]);
  assert.deepEqual(result.headers.host, [{ key: "host", value: CONFIG.apiDomain }]);
});

test("preview Host + /j/* (share-link previews) routes like /api*", () => {
  const request = cfRequest({ uri: "/j/ABC123" });
  const result = routeRequest(request, CONFIG);
  assert.equal(result.origin.custom.domainName, CONFIG.apiDomain);
});

test("blank secret omits the custom header instead of sending an empty value", () => {
  const request = cfRequest({ uri: "/api/getState" });
  const result = routeRequest(request, { ...CONFIG, apiSecret: "" });
  assert.deepEqual(result.origin.custom.customHeaders, {});
});
