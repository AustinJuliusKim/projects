import test from "node:test";
import assert from "node:assert/strict";

import {
  loadConfig,
  parseSourcesConfig,
  parseModelsConfig,
  parseSettingsConfig,
  assertPricingCoverage,
  DEFAULT_FOUNDRY_DIR,
  ROLES,
} from "../src/config.js";

// --- the real committed config must validate ---

test("loadConfig validates the committed foundry/ config", () => {
  const { sources, models, settings, foundryDir } = loadConfig();
  assert.equal(foundryDir, DEFAULT_FOUNDRY_DIR);

  assert.ok(sources.sources.length >= 4 && sources.sources.length <= 6, "registry stays small (3-5 content + bench trigger)");
  const ids = sources.sources.map((s) => s.id);
  assert.ok(ids.includes("claude-code-releases"));
  assert.ok(ids.includes("anthropic-news"));

  const benchTriggers = sources.sources.filter((s) => s.benchTrigger);
  assert.deepEqual(benchTriggers.map((s) => s.id), ["anthropic-news"]);

  for (const role of ROLES) {
    assert.ok(models.roles[role], `role ${role} present`);
    assert.equal(models.roles[role].provider, "anthropic", "v1 provider default");
  }
  assert.equal(models.roles.author.model, "claude-fable-5");
  assert.equal(models.roles.scout.model, "claude-haiku-4-5");
  // Judge is fixed and never a contestant: no bench candidates configured.
  assert.deepEqual(models.roles.judge.benchCandidates, []);

  assert.equal(settings.topN, 3);
  assert.equal(settings.budgetCapUsd, 10);
  assert.equal(settings.overlapThreshold, 0.65);
  assert.equal(settings.labels.draft, "foundry:draft");
  assert.equal(settings.labels.radar, "foundry:radar");
  assert.equal(settings.branchPrefix, "foundry/");
  assert.match(settings.cadenceCron, /^\S+ \S+ \S+ \S+ \S+$/);
  assert.equal(settings.authorMaxTurns, 3);
});

// --- rejection cases ---

const validSource = { id: "x", method: "rss", url: "https://example.com/feed.xml", cadence: "monthly" };

test("sources: unknown keys are a hard error", () => {
  assert.throws(
    () => parseSourcesConfig({ sources: [{ ...validSource, surprise: true }] }),
    /Invalid sources\.yaml/,
  );
});

test("sources: github methods require repo; feed methods require url", () => {
  assert.throws(
    () => parseSourcesConfig({ sources: [{ id: "gh", method: "githubReleases", cadence: "monthly" }] }),
    /requires repo/,
  );
  assert.throws(
    () => parseSourcesConfig({ sources: [{ id: "feed", method: "rss", cadence: "monthly" }] }),
    /requires url/,
  );
});

test("sources: unknown method and duplicate ids rejected", () => {
  assert.throws(() => parseSourcesConfig({ sources: [{ ...validSource, method: "scrapeHard" }] }));
  assert.throws(
    () => parseSourcesConfig({ sources: [validSource, { ...validSource }] }),
    /duplicate source id/,
  );
});

const validRole = { model: "claude-haiku-4-5" };
const validRoles = { scout: validRole, author: validRole, linter: validRole, judge: validRole };

test("models: unknown role is a hard error", () => {
  assert.throws(
    () => parseModelsConfig({ roles: { ...validRoles, poet: validRole } }),
    /Invalid models\.yaml/,
  );
});

test("models: missing role is a hard error", () => {
  const { judge: _judge, ...missing } = validRoles;
  assert.throws(() => parseModelsConfig({ roles: missing }), /Invalid models\.yaml/);
});

test("settings: overlapThreshold outside [0,1] rejected", () => {
  const { settings } = loadConfig();
  assert.throws(() => parseSettingsConfig({ ...structuredClone(settings), overlapThreshold: 1.5 }));
});

test("settings: authorMaxTurns defaults to 3 when omitted, rejects non-int/<1", () => {
  const { settings } = loadConfig();
  const { authorMaxTurns: _omit, ...withoutTurns } = structuredClone(settings);
  assert.equal(parseSettingsConfig(withoutTurns).authorMaxTurns, 3);
  assert.equal(parseSettingsConfig({ ...structuredClone(settings), authorMaxTurns: 5 }).authorMaxTurns, 5);
  assert.throws(() => parseSettingsConfig({ ...structuredClone(settings), authorMaxTurns: 0 }));
  assert.throws(() => parseSettingsConfig({ ...structuredClone(settings), authorMaxTurns: 2.5 }));
});

test("pricing coverage: model referenced without a pricing entry is a hard error", () => {
  const models = parseModelsConfig({
    roles: { ...validRoles, author: { model: "claude-unpriced-9" } },
  });
  const { settings } = loadConfig();
  assert.throws(() => assertPricingCoverage(models, settings), /no pricing entry/);
});

test("pricing coverage: bench candidates are checked too", () => {
  const models = parseModelsConfig({
    roles: { ...validRoles, linter: { model: "claude-haiku-4-5", benchCandidates: ["claude-unpriced-9"] } },
  });
  const { settings } = loadConfig();
  assert.throws(() => assertPricingCoverage(models, settings), /claude-unpriced-9/);
});
