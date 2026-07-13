import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createAgentClient } from "../src/agent/agentClient.js";
import { usageToUsd, costForModel, CACHE_WRITE_MULTIPLIER, CACHE_READ_MULTIPLIER } from "../src/agent/pricing.js";
import { loadConfig } from "../src/config.js";
import { createFakeAgent } from "./fakes/fakeAgent.js";

const { models, settings } = loadConfig();

test("role→model routing follows models.yaml", async () => {
  const { queryImpl, calls } = createFakeAgent({ responses: ["scout note", "draft yaml"] });
  const client = createAgentClient({ queryImpl, models, pricing: settings.pricing });

  const scout = await client.complete({ role: "scout", prompt: "delta please" });
  assert.equal(scout.model, "claude-haiku-4-5");
  assert.equal(scout.text, "scout note");

  const author = await client.complete({ role: "author", prompt: "write a lesson" });
  assert.equal(author.model, "claude-fable-5");

  assert.deepEqual(
    calls.map((c) => [c.role, c.model]),
    [
      ["scout", "claude-haiku-4-5"],
      ["author", "claude-fable-5"],
    ],
  );
});

test("per-run override (--model-<role>) beats models.yaml; explicit model beats both", async () => {
  const { queryImpl } = createFakeAgent();
  const client = createAgentClient({
    queryImpl,
    models,
    pricing: settings.pricing,
    overrides: { author: "claude-opus-4-8" },
  });

  assert.equal(client.modelForRole("author"), "claude-opus-4-8");
  assert.equal(client.modelForRole("scout"), "claude-haiku-4-5");

  const overridden = await client.complete({ role: "author", prompt: "x" });
  assert.equal(overridden.model, "claude-opus-4-8");

  const explicit = await client.complete({ role: "author", prompt: "x", model: "claude-sonnet-4-6" });
  assert.equal(explicit.model, "claude-sonnet-4-6");
});

test("unknown role is a hard error", async () => {
  const { queryImpl } = createFakeAgent();
  const client = createAgentClient({ queryImpl, models, pricing: settings.pricing });
  await assert.rejects(client.complete({ role: "poet", prompt: "x" }), /unknown role "poet"/);
});

test("cost math: usage → USD per the pricing table", async () => {
  const haiku = settings.pricing["claude-haiku-4-5"];
  // 1M in + 1M out on haiku = $1 + $5.
  assert.equal(usageToUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, haiku), 6);

  // Cache tokens bill at input-price multipliers.
  const cached = usageToUsd(
    { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
    haiku,
  );
  assert.ok(Math.abs(cached - (1 * CACHE_WRITE_MULTIPLIER + 1 * CACHE_READ_MULTIPLIER)) < 1e-9);

  assert.throws(() => costForModel({}, "claude-unpriced-9", settings.pricing), /No pricing entry/);

  const { queryImpl } = createFakeAgent({
    responses: [{ text: "hi", usage: { input_tokens: 2_000_000, output_tokens: 100_000 } }],
  });
  const client = createAgentClient({ queryImpl, models, pricing: settings.pricing });
  const result = await client.complete({ role: "scout", prompt: "x" });
  // haiku: 2 * $1 + 0.1 * $5 = $2.50
  assert.ok(Math.abs(result.costUsd - 2.5) < 1e-9);
});

test("constructing the client performs no network I/O and no SDK import", () => {
  // Construction with the *default* queryImpl must be synchronous and inert.
  const client = createAgentClient({ models, pricing: settings.pricing });
  assert.equal(typeof client.complete, "function");

  // Structural guarantee: the SDK is only reachable via a lazy dynamic
  // import inside the default queryImpl — never a static top-level import.
  const src = readFileSync(fileURLToPath(new URL("../src/agent/agentClient.js", import.meta.url)), "utf8");
  assert.ok(!/^import .*claude-agent-sdk/m.test(src), "no static import of the Agent SDK");
  assert.match(src, /await import\("@anthropic-ai\/claude-agent-sdk"\)/);
});
