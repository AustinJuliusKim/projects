/**
 * Relational-expressibility gate.
 *
 * Walks the compiled canon and prints the INSERTs it *would* generate against
 * the tables in content/SCHEMA.md. Writes nothing, connects to nothing.
 *
 * The point is not to migrate anything today — v1 has no database and doesn't
 * need one. The point is that "this content is importable into DB records
 * later" stays *true* as the canon grows from 3 foods to 100, instead of being
 * a claim we discover is false in January. Any record that can't be flattened
 * into these tables fails the run.
 *
 * CLI:
 *   node scripts/emit-sql.js --dry-run
 */

import { compile } from "./compile-content.js";

/** Top-level keys that map to a column on `foods`. */
const SCALAR_COLUMNS = new Set([
  "id",
  "name",
  "category",
  "firstOkMonths",
  "hardAgeRestrictionMonths",
  "prohibitedBeforeMonths",
  "prohibitionReason",
  "prepMinutes",
  "backgroundMd",
  "safetyNoteMd",
  "allergenRegion",
]);

/** Keys that expand into child tables. */
const CHILD_TABLES = new Set([
  "ageBands",
  "allergens",
  "sources",
  "relatedIds",
  "cultural",
  "aliases",
]);

/** Flat objects whose own keys map to columns. */
const FLAT_OBJECTS = new Set(["choking", "nutrients", "allergenProtocol"]);

const q = (v) =>
  v === undefined || v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

/**
 * @param {object[]} foods
 * @returns {string[]} SQL statements
 */
function emit(foods) {
  const out = [];
  const problems = [];

  for (const food of foods) {
    for (const [key, value] of Object.entries(food)) {
      if (SCALAR_COLUMNS.has(key)) {
        if (value !== undefined && typeof value === "object") {
          problems.push(`${food.id}.${key}: expected a scalar column, got ${Array.isArray(value) ? "an array" : "an object"}`);
        }
        continue;
      }
      if (CHILD_TABLES.has(key)) {
        if (value !== undefined && !Array.isArray(value)) {
          problems.push(`${food.id}.${key}: expected an array for a child table, got ${typeof value}`);
        }
        continue;
      }
      if (FLAT_OBJECTS.has(key)) {
        if (value === undefined) continue;
        for (const [k, v] of Object.entries(value)) {
          if (v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v)) {
            problems.push(`${food.id}.${key}.${k}: nested object cannot be a column`);
          }
        }
        continue;
      }
      problems.push(`${food.id}.${key}: no column or child table in SCHEMA.md maps this key`);
    }

    out.push(
      `INSERT INTO foods (id, name, category, first_ok_months, choking_level, choking_note, iron_type, iron_mg_per_100g, protein_g_per_100g, fdc_id, prep_minutes, background_md, safety_note_md, hard_age_restriction_months, prohibited_before_months, prohibition_reason) VALUES (${[
        food.id,
        food.name,
        food.category,
        food.firstOkMonths,
        food.choking?.level,
        food.choking?.note,
        food.nutrients?.ironType,
        food.nutrients?.ironMgPer100g,
        food.nutrients?.proteinGPer100g,
        food.nutrients?.fdcId,
        food.prepMinutes,
        food.backgroundMd,
        food.safetyNoteMd,
        food.hardAgeRestrictionMonths,
        food.prohibitedBeforeMonths,
        food.prohibitionReason,
      ]
        .map(q)
        .join(", ")});`,
    );

    for (const b of food.ageBands ?? []) {
      out.push(
        `INSERT INTO food_age_bands (food_id, band, geometry, prep_md, serving_note) VALUES (${[food.id, b.band, b.geometry, b.prepMd, b.servingNote].map(q).join(", ")});`,
      );
    }
    for (const a of food.allergens ?? []) {
      out.push(
        `INSERT INTO food_allergens (food_id, allergen, region_scope) VALUES (${[food.id, a, food.allergenRegion].map(q).join(", ")});`,
      );
    }
    if (food.allergenProtocol) {
      const p = food.allergenProtocol;
      out.push(
        `INSERT INTO food_allergen_protocol (food_id, allergen, first_dose, protein_g_per_tsp, maintenance_protein_g_per_week, maintenance_min_sessions_per_week, medical_gate) VALUES (${[food.id, p.allergen, p.firstDose, p.proteinGPerTsp, p.maintenanceProteinGPerWeek, p.maintenanceMinSessionsPerWeek, p.medicalGate].map(q).join(", ")});`,
      );
    }
    for (const s of food.sources ?? []) {
      out.push(
        `INSERT INTO food_sources (food_id, url, body, tier, retrieved) VALUES (${[food.id, s.url, s.body, s.tier, s.retrieved].map(q).join(", ")});`,
      );
    }
    for (const r of food.relatedIds ?? []) {
      out.push(`INSERT INTO food_relations (food_id, related_id) VALUES (${[food.id, r].map(q).join(", ")});`);
    }
    for (const t of food.nutrients?.tags ?? []) {
      out.push(`INSERT INTO food_nutrient_tags (food_id, tag) VALUES (${[food.id, t].map(q).join(", ")});`);
    }
    for (const t of food.cultural ?? []) {
      out.push(`INSERT INTO food_cultural_tags (food_id, tag) VALUES (${[food.id, t].map(q).join(", ")});`);
    }
  }

  if (problems.length) {
    const err = new Error(
      `content is not relationally expressible — SCHEMA.md needs updating, or the record needs flattening:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    throw err;
  }
  return out;
}

function main() {
  if (!process.argv.includes("--dry-run")) {
    console.error("emit-sql.js only supports --dry-run (it never writes to a database)");
    process.exit(2);
  }
  let statements;
  try {
    statements = emit(compile().foods);
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  }
  console.log(statements.join("\n"));
  console.error(`\n✓ ${statements.length} statements — every record is relationally expressible`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { emit };
