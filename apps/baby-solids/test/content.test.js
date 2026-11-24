/**
 * Proves the content gates actually fire.
 *
 * A build gate that has never been seen to fail is indistinguishable from no
 * gate at all — and these particular gates are the reason a typo in an
 * allergen id or a dropped medical warning can't reach a food record
 * silently. Each case writes a deliberately broken food into a temp dir and
 * asserts the compile throws.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../scripts/compile-content.js";
import { emit } from "../scripts/emit-sql.js";

const REAL = readFileSync(new URL("../content/foods/sweet-potato.md", import.meta.url), "utf8");

/**
 * The real record with its cross-link flattened, so single-file fixtures
 * aren't rejected by relation resolution. The link itself gets its own test.
 */
const GOOD = REAL.replace("[[kabocha]]", "kabocha");

/**
 * Compiles a temp canon built from `{filename: contents}`.
 * @param {Record<string, string>} files
 */
function compileFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "baby-solids-content-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return compile({ foodsDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Removes a frontmatter block by key, e.g. `sources`. */
function withoutBlock(md, key) {
  return md.replace(new RegExp(`^${key}:\\n(?:  .*\\n|    .*\\n|  - .*\\n)+`, "m"), "");
}

test("a valid canon compiles", () => {
  const built = compileFixture({ "sweet-potato.md": GOOD });
  assert.equal(built.foods.length, 1);
  assert.equal(built.foods[0].id, "sweet-potato");
});

test("FAILS: a food with no sources", () => {
  assert.throws(
    () => compileFixture({ "sweet-potato.md": withoutBlock(GOOD, "sources") }),
    /source/i,
  );
});

test("FAILS: an unknown allergen id", () => {
  const broken = GOOD.replace("allergens: []", "allergens: [peanutt]");
  assert.throws(() => compileFixture({ "sweet-potato.md": broken }), /allergens/i);
});

test("FAILS: an unresolvable geometry id", () => {
  const broken = GOOD.replace("geometry: spear-two-finger", "geometry: spear-three-finger");
  assert.throws(() => compileFixture({ "sweet-potato.md": broken }), /geometry/i);
});

test("FAILS: a duplicate id (two files claiming the same primary key)", () => {
  // The id must equal the filename, so a second file claiming the same id is
  // caught by the filename check — the invariant that keeps ids stable.
  assert.throws(
    () => compileFixture({ "sweet-potato.md": GOOD, "sweet-potato-2.md": GOOD }),
    /must match the filename/,
  );
});

test("FAILS: a category absent from enums.yaml", () => {
  const broken = GOOD.replace("category: vegetable", "category: superfood");
  assert.throws(() => compileFixture({ "sweet-potato.md": broken }), /category/i);
});

test("FAILS: an allergenProtocol with no medicalGate — the hard safety invariant", () => {
  const withProtocol = GOOD.replace(
    "allergens: []",
    [
      "allergens: [peanut]",
      "allergenProtocol:",
      "  allergen: peanut",
      "  firstDose: thinned peanut butter",
    ].join("\n"),
  );
  assert.throws(() => compileFixture({ "sweet-potato.md": withProtocol }), /medicalGate/);
});

test("FAILS: a [[wikilink]] that does not resolve to a food", () => {
  const broken = REAL.replace("[[kabocha]]", "[[not-a-real-food]]");
  assert.throws(() => compileFixture({ "sweet-potato.md": broken }), /does not resolve/);
});

test("FAILS: an age band declared with no matching prep section", () => {
  const broken = GOOD.replace(/^## Prep 9-11$/m, "## Prep nine to eleven");
  assert.throws(() => compileFixture({ "sweet-potato.md": broken }), /no matching/);
});

test("FAILS: choking level 'avoid' with no explanatory note", () => {
  const broken = GOOD.replace(
    /choking:\n  level: low\n  requiredModification: .*\n/,
    "choking:\n  level: avoid\n",
  );
  assert.throws(() => compileFixture({ "sweet-potato.md": broken }), /requires choking\.note/);
});

test("emit-sql rejects a record that cannot be expressed relationally", () => {
  // A nested object where SCHEMA.md expects a column. This is the gate that
  // keeps "importable into DB records later" true as the canon grows.
  const food = { ...compileFixture({ "sweet-potato.md": GOOD }).foods[0], prepMinutes: { x: 1 } };
  assert.throws(() => emit([food]), /not relationally expressible/);
});

test("emit-sql accepts the real canon", () => {
  const { foods } = compileFixture({ "sweet-potato.md": GOOD });
  assert.ok(emit(foods).length > 0);
});
