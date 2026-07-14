import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { authorDraft, extractYamlBlock } from "../src/author/author.js";
import { buildFixedBlock, buildTopicBlock, buildAuthorPrompt, EXEMPLAR_PATH, SCHEMA_DIGEST } from "../src/author/promptPack.js";
import { createAgentClient } from "../src/agent/agentClient.js";
import { loadConfig } from "../src/config.js";
import { createFakeAgent } from "./fakes/fakeAgent.js";

const { models, settings } = loadConfig();
const VALID_YAML = readFileSync(fileURLToPath(new URL("./fixtures/valid-draft.yaml", import.meta.url)), "utf8");
const VALID_REPLY = `Here is the lesson.\n\n\`\`\`yaml\n${VALID_YAML}\`\`\`\n`;
const CARD = { topic: "Evaluating RAG retrieval quality", whyNow: "New eval tooling this month" };

function makeClient(responses) {
  const fake = createFakeAgent({ responses });
  return { fake, client: createAgentClient({ queryImpl: fake.queryImpl, models, pricing: settings.pricing }) };
}

test("fixed block embeds l1.yaml verbatim, licensing rules, and the schema digest", () => {
  const fixed = buildFixedBlock();
  const exemplar = readFileSync(EXEMPLAR_PATH, "utf8");
  assert.ok(fixed.includes(exemplar.trimEnd()), "l1.yaml embedded verbatim");
  assert.match(fixed, /Registry courses are RADAR, not raw material/);
  assert.match(fixed, /ORIGINAL, grounded in the primary sources/);
  assert.match(fixed, /durationTargetSec <= 330/);
  assert.match(fixed, /EXACTLY ONE assertion step/);
  assert.ok(fixed.includes(SCHEMA_DIGEST));
  // v1 seeder constraints are encoded in the prompt (reality-check #4).
  assert.match(fixed, /"<lessonId>-input"/);
  assert.match(fixed, /"acceptEdits" or "plan"/);
});

test("schema digest names every step type the protocol schema accepts", () => {
  const stepTypes = [
    "instruction", "promptBuilder", "run", "annotation", "permissionPrompt",
    "quiz", "assertion", "terminalDrill", "capture",
  ];
  for (const t of stepTypes) assert.ok(SCHEMA_DIGEST.includes(t), `digest mentions ${t}`);
});

test("fixed block is byte-stable across topics within a run", () => {
  const a = buildFixedBlock();
  const b = buildFixedBlock();
  assert.equal(a, b);
  const promptA = buildAuthorPrompt(a, buildTopicBlock({ topic: "Topic A" }));
  const promptB = buildAuthorPrompt(a, buildTopicBlock({ topic: "Topic B" }));
  assert.ok(promptA.startsWith(a) && promptB.startsWith(a), "shared prefix = prompt-cache friendly");
});

test("authorDraft: valid YAML on first attempt", async () => {
  const { fake, client } = makeClient([
    { text: VALID_REPLY, usage: { input_tokens: 40_000, output_tokens: 2_000 } },
  ]);
  const { doc, yamlText, provenance } = await authorDraft({ agentClient: client, card: CARD });

  assert.equal(doc.id, "l9");
  assert.equal(doc.track, "advanced");
  assert.match(yamlText, /schemaVersion: 1/);
  assert.equal(provenance.role, "author");
  assert.equal(provenance.model, "claude-fable-5");
  assert.equal(provenance.attempts, 1);
  // fable-5: 40k * $10/M + 2k * $50/M = 0.4 + 0.1 = $0.50
  assert.ok(Math.abs(provenance.costUsd - 0.5) < 1e-9);
  assert.deepEqual(provenance.tokens, { input_tokens: 40_000, output_tokens: 2_000 });
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].prompt.includes(CARD.topic));
});

test("authorDraft: garbage then valid — one retry with the error appended", async () => {
  const { fake, client } = makeClient(["no yaml here at all", { text: VALID_REPLY }]);
  const { provenance } = await authorDraft({ agentClient: client, card: CARD });

  assert.equal(provenance.attempts, 2);
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1].prompt, /previous draft was rejected/);
  assert.match(fake.calls[1].prompt, /no fenced ```yaml block/);
});

test("authorDraft: Zod-invalid YAML triggers retry with the validation message", async () => {
  const invalid = "```yaml\nschemaVersion: 1\nid: bad\n```";
  const { fake, client } = makeClient([invalid, { text: VALID_REPLY }]);
  const { provenance } = await authorDraft({ agentClient: client, card: CARD });
  assert.equal(provenance.attempts, 2);
  assert.match(fake.calls[1].prompt, /Invalid lesson/);
});

test("authorDraft: fails hard after the second bad attempt", async () => {
  const { client } = makeClient(["garbage one", "garbage two"]);
  await assert.rejects(authorDraft({ agentClient: client, card: CARD }), /draft failed after retry/);
});

test("authorDraft: retries an SDK error (error_max_turns) then succeeds", async () => {
  let n = 0;
  const queryImpl = async () => {
    if (++n === 1) throw new Error("agentClient: query ended with error_max_turns");
    return { text: VALID_REPLY, usage: { input_tokens: 40_000, output_tokens: 2_000 } };
  };
  const client = createAgentClient({ queryImpl, models, pricing: settings.pricing });
  const { provenance } = await authorDraft({ agentClient: client, card: CARD });
  assert.equal(provenance.attempts, 2);
  assert.equal(n, 2, "the failed first attempt was retried, not escaped");
});

test("authorDraft: a persistent SDK error fails hard after retry", async () => {
  const queryImpl = async () => {
    throw new Error("agentClient: query ended with error_max_turns");
  };
  const client = createAgentClient({ queryImpl, models, pricing: settings.pricing });
  await assert.rejects(authorDraft({ agentClient: client, card: CARD }), /draft failed after retry — .*error_max_turns/);
});

test("extractYamlBlock handles yml fences and missing blocks", () => {
  assert.equal(extractYamlBlock("```yml\nfoo: 1\n```"), "foo: 1\n");
  assert.throws(() => extractYamlBlock("plain text"), /no fenced/);
});

test("topic block includes fetched primary sources", () => {
  const block = buildTopicBlock(CARD, [
    { title: "Release v2.5.0", url: "https://example.com/r", date: "2026-07-01", body: "notes" },
  ]);
  assert.match(block, /Release v2\.5\.0/);
  assert.match(block, /ground every claim/);
});
