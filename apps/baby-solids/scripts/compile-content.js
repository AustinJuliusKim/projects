/**
 * Food canon compiler: Markdown + YAML frontmatter in content/foods/ →
 * validated JSON at src/generated/foods.json.
 *
 * Mirrors packages/guided-repl-lessons/src/compile.js: broken references and
 * schema violations fail the build, not the user. The difference here is what
 * a failure prevents — this dataset tells a parent what to put in a baby's
 * mouth, so "the build is the reviewer" is the whole design.
 *
 * CLI:
 *   node scripts/compile-content.js            build src/generated/foods.json
 *   node scripts/compile-content.js --check    compile in memory, diff against
 *                                              the committed JSON, fail on drift
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { buildFoodSchema } from "./foodSchema.js";
import { buildSearchIndex } from "./searchIndex.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOODS_DIR = join(APP_ROOT, "content/foods");
const ENUMS_PATH = join(APP_ROOT, "content/enums.yaml");
const OUT = join(APP_ROOT, "src/generated/foods.json");

class ContentError extends Error {}

/**
 * Splits `---\nfrontmatter\n---\nbody`.
 *
 * @param {string} raw
 * @param {string} file
 * @returns {{front: object, body: string}}
 */
function splitFrontmatter(raw, file) {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) throw new ContentError(`${file}: missing YAML frontmatter`);
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new ContentError(`${file}: unterminated frontmatter`);
  const front = parseYaml(text.slice(3, end));
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  return { front: front ?? {}, body };
}

/**
 * Splits a Markdown body into `## Heading` → text. This is what makes prose
 * addressable: the body is structured data, not an opaque blob, so it maps to
 * columns like every other field.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
function sectionsOf(body) {
  /** @type {Record<string, string>} */
  const out = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) out[current] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1].toLowerCase();
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** @param {string} text @returns {string[]} */
function wikilinksIn(text) {
  return [...text.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map((m) => m[1]);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.foodsDir]
 * @returns {{foods: object[], index: object, generatedAt: null}}
 */
export function compile({ foodsDir = FOODS_DIR } = {}) {
  const enums = parseYaml(readFileSync(ENUMS_PATH, "utf8"));
  const schema = buildFoodSchema(enums);

  if (!existsSync(foodsDir)) throw new ContentError(`missing content dir: ${foodsDir}`);
  const files = readdirSync(foodsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) throw new ContentError(`no food files in ${foodsDir}`);

  /** @type {Map<string, object>} */
  const byId = new Map();

  for (const file of files) {
    const raw = readFileSync(join(foodsDir, file), "utf8");
    const { front, body } = splitFrontmatter(raw, file);
    const sections = sectionsOf(body);
    const slug = basename(file, ".md");

    if (front.id !== slug) {
      throw new ContentError(
        `${file}: id "${front.id}" must match the filename "${slug}" — the id is the primary key`,
      );
    }
    if (byId.has(front.id)) throw new ContentError(`${file}: duplicate id "${front.id}"`);

    // Prose sections → keyed fields.
    const draft = {
      ...front,
      backgroundMd: sections.background,
      safetyNoteMd: sections.safety,
      relatedIds: [...new Set(wikilinksIn(body))],
      ageBands: (front.ageBands ?? []).map((b) => ({
        ...b,
        prepMd: sections[`prep ${b.band}`],
      })),
    };

    let food;
    try {
      food = schema.parse(draft);
    } catch (err) {
      const issues = (err.issues ?? []).map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
      throw new ContentError(`${file}: schema validation failed\n${issues.join("\n")}`);
    }

    for (const band of food.ageBands) {
      if (!band.prepMd) {
        throw new ContentError(
          `${file}: age band "${band.band}" has no matching "## Prep ${band.band}" section`,
        );
      }
    }
    if (food.choking.level === "avoid" && !food.choking.note) {
      throw new ContentError(`${file}: choking.level "avoid" requires choking.note`);
    }
    byId.set(food.id, food);
  }

  // Relations resolve only after every id is known.
  for (const food of byId.values()) {
    for (const rel of food.relatedIds) {
      if (!byId.has(rel)) {
        throw new ContentError(`${food.id}: [[${rel}]] does not resolve to a food`);
      }
    }
  }

  const foods = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { foods, index: buildSearchIndex(foods), generatedAt: null };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  let built;
  try {
    built = compile();
  } catch (err) {
    console.error(`\n✗ content build failed\n${err.message}\n`);
    process.exit(1);
  }
  const json = `${JSON.stringify(built, null, 2)}\n`;

  if (check) {
    if (!existsSync(OUT)) {
      console.error(`✗ ${OUT} is missing — run: npm run build:content`);
      process.exit(1);
    }
    if (readFileSync(OUT, "utf8") !== json) {
      console.error(
        "✗ src/generated/foods.json is out of date with content/foods/ — run: npm run build:content",
      );
      process.exit(1);
    }
    console.log(`✓ content in sync (${built.foods.length} foods)`);
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`✓ compiled ${built.foods.length} foods → src/generated/foods.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
