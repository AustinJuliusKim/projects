/**
 * Foundry config loader: reads and Zod-validates the repo-root foundry/
 * config dir ({sources,models,settings}.yaml).
 *
 * Hard rules enforced here:
 *   - unknown keys anywhere are a hard error (strict schemas);
 *   - only the four known roles (scout/author/linter/judge) may appear;
 *   - github methods require `repo`, feed/scrape methods require `url`;
 *   - every model id referenced in models.yaml (role models + bench
 *     candidates) must have a pricing entry in settings.yaml.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Repo-root foundry/ dir (this file lives at services/guided-repl-foundry/src/). */
export const DEFAULT_FOUNDRY_DIR = resolve(PKG_ROOT, "../../foundry");

export const SOURCE_METHODS = ["githubReleases", "githubCommits", "rss", "htmlList"];
export const ROLES = ["scout", "author", "linter", "judge"];

const SourceSchema = z
  .strictObject({
    id: z.string().min(1),
    method: z.enum(SOURCE_METHODS),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name")
      .optional(),
    url: z.url().optional(),
    cadence: z.enum(["monthly", "weekly"]),
    benchTrigger: z.boolean().default(false),
  })
  .superRefine((source, ctx) => {
    const needsRepo = source.method === "githubReleases" || source.method === "githubCommits";
    if (needsRepo && !source.repo) {
      ctx.addIssue({ code: "custom", message: `source "${source.id}" (${source.method}) requires repo` });
    }
    if (!needsRepo && !source.url) {
      ctx.addIssue({ code: "custom", message: `source "${source.id}" (${source.method}) requires url` });
    }
  });

export const SourcesConfigSchema = z
  .strictObject({
    sources: z.array(SourceSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set();
    for (const source of cfg.sources) {
      if (seen.has(source.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate source id "${source.id}"` });
      }
      seen.add(source.id);
    }
  });

const RoleSchema = z.strictObject({
  model: z.string().min(1),
  provider: z.string().default("anthropic"),
  benchCandidates: z.array(z.string().min(1)).default([]),
});

export const ModelsConfigSchema = z.strictObject({
  // strictObject rejects any role outside the known four.
  roles: z.strictObject({
    scout: RoleSchema,
    author: RoleSchema,
    linter: RoleSchema,
    judge: RoleSchema,
  }),
});

const PricingEntrySchema = z.strictObject({
  inputPerMTok: z.number().positive(),
  outputPerMTok: z.number().positive(),
});

export const SettingsConfigSchema = z.strictObject({
  topN: z.number().int().min(1),
  budgetCapUsd: z.number().positive(),
  overlapThreshold: z.number().min(0).max(1),
  cadenceCron: z.string().min(1),
  labels: z.strictObject({
    draft: z.string().min(1),
    radar: z.string().min(1),
  }),
  branchPrefix: z.string().min(1),
  pricing: z.record(z.string(), PricingEntrySchema),
});

/**
 * Validates one parsed YAML document against a schema, throwing a readable
 * message on the first problem (matching guided-repl validator conventions).
 *
 * @param {import("zod").ZodType} schema
 * @param {unknown} obj
 * @param {string} label file label for error messages
 */
function validateDoc(schema, obj, label) {
  const result = schema.safeParse(obj);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length ? ` at ${first.path.join(".")}` : "";
    throw new Error(`Invalid ${label}${path}: ${first.message}`);
  }
  return result.data;
}

/** @param {unknown} obj */
export function parseSourcesConfig(obj) {
  return validateDoc(SourcesConfigSchema, obj, "sources.yaml");
}

/** @param {unknown} obj */
export function parseModelsConfig(obj) {
  return validateDoc(ModelsConfigSchema, obj, "models.yaml");
}

/** @param {unknown} obj */
export function parseSettingsConfig(obj) {
  return validateDoc(SettingsConfigSchema, obj, "settings.yaml");
}

/**
 * Cross-file invariant: every model id referenced by models.yaml (role models
 * and bench candidates) must have a pricing entry in settings.yaml.
 *
 * @param {{roles: Record<string, {model: string, benchCandidates: string[]}>}} models
 * @param {{pricing: Record<string, object>}} settings
 */
export function assertPricingCoverage(models, settings) {
  for (const [role, cfg] of Object.entries(models.roles)) {
    for (const modelId of [cfg.model, ...cfg.benchCandidates]) {
      if (!settings.pricing[modelId]) {
        throw new Error(
          `models.yaml role "${role}" references model "${modelId}" with no pricing entry in settings.yaml`,
        );
      }
    }
  }
}

/**
 * Loads and validates the full Foundry config.
 *
 * @param {{foundryDir?: string}} [opts]
 * @returns {{sources: object, models: object, settings: object, foundryDir: string}}
 */
export function loadConfig({ foundryDir = DEFAULT_FOUNDRY_DIR } = {}) {
  const read = (name) => parseYaml(readFileSync(join(foundryDir, name), "utf8"));
  const sources = parseSourcesConfig(read("sources.yaml"));
  const models = parseModelsConfig(read("models.yaml"));
  const settings = parseSettingsConfig(read("settings.yaml"));
  assertPricingCoverage(models, settings);
  return { sources, models, settings, foundryDir };
}
